"""The Python side of the pi kernel: read one JSON request per line, run it in a
persistent namespace, answer with typed JSON frames on stdout.

WHY THIS FILE IS NOT AN IPYKERNEL. ipykernel speaks ZeroMQ over unix sockets and
srt's seccomp filter blocks socket(AF_UNIX) — measured, it is what killed
@playwright/mcp in this harness (HIV-1636) and what forces devservices' Postgres
to run with unix_socket_directories=''. A pipe needs no denied syscall, so the
transport is NDJSON over the stdin/stdout of a plain `python -u runner.py`. The
cost is that we reimplement the small useful part of IPython (a persistent
namespace, the value of the last expression, four magics) instead of inheriting
all of it. The cost is worth paying because the alternative does not run.

THE INVARIANT EVERYTHING ELSE SERVES: fd 1 carries frames and only frames while
we control it. `print` inside a cell must not corrupt the stream, so sys.stdout
is replaced for the duration of the cell by a writer that wraps each chunk in a
frame. The real stdout is captured once, at import, and never handed out.

The one hole is deliberate: a subprocess started by the cell inherits the real fd
1 and writes raw bytes between frames. Closing it would mean giving up !cmd and
%%bash, which are what make this usable without becoming a shell. The host reads
an unparseable line as stdout instead (see protocol.ts `parseFrame`), so the hole
costs a label, not a session.
"""

import ast
import io
import json
import os
import shlex
import subprocess
import sys
import traceback

# Captured before anything can rebind sys.stdout. Every frame goes here.
_FRAMES = sys.__stdout__


def emit(kind, request_id, text="", **extra):
    """Write one frame. Flushed every time: the host is waiting on this line."""
    frame = {"type": kind, "id": request_id, "text": text}
    frame.update(extra)
    _FRAMES.write(json.dumps(frame) + "\n")
    _FRAMES.flush()


class FrameWriter(io.TextIOBase):
    """A file-like that turns writes into frames.

    Installed as sys.stdout/sys.stderr for the duration of a cell. Unbuffered on
    purpose: a cell that is going to be interrupted at its timeout should still
    have delivered what it printed before the interrupt, which is exactly the
    case where the output matters most.
    """

    def __init__(self, kind, request_id):
        self._kind = kind
        self._id = request_id

    def write(self, text):
        if text:
            emit(self._kind, self._id, text)
        return len(text)

    def flush(self):
        pass

    def writable(self):
        return True


def stream_process(argv, request_id, shell=False, stdin_text=None):
    """Run a child and relay its output as frames, line by line.

    Line-by-line rather than communicate(): a `%pip install` of something large
    is the main user of this path, and watching it work is the difference between
    a tool call that looks alive and one that looks hung.
    """
    proc = subprocess.Popen(
        argv,
        shell=shell,
        stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    if stdin_text is not None:
        try:
            proc.stdin.write(stdin_text)
        finally:
            proc.stdin.close()
    for line in proc.stdout:
        emit("stdout", request_id, line)
    code = proc.wait()
    if code != 0:
        emit("stderr", request_id, "[exit %d]\n" % code)
    return code


def format_error():
    """The traceback, with this file's own frames removed.

    A model reads a traceback as a map of its own code. Leaving
    `File ".../runner.py", line 156, in run_cell` at the top of it is a standing
    invitation to debug the harness instead of the cell — and one frame of
    honesty costs nothing, because everything below it is still there.
    """
    etype, evalue, tb = sys.exc_info()
    if tb is not None:
        tb = tb.tb_next  # drop the run_cell frame
    return "".join(traceback.format_exception(etype, evalue, tb))


def run_magic(line, request_id):
    """Handle a single-line magic. Returns True when the line was consumed.

    Kept to four, and each earns its place by being something you cannot express
    in the cell body: %pip because the interpreter running the cell is the one
    that must receive the package, %cd because os.chdir is easy to forget and
    relative paths are everywhere, and !cmd / %%bash because reaching for the
    shell mid-analysis is normal and shelling out via subprocess.run boilerplate
    every time is not. Anything more and this becomes a second bash tool, which
    is explicitly not what the kernel is for.
    """
    stripped = line.strip()
    if stripped.startswith("%pip "):
        stream_process([sys.executable, "-m", "pip"] + shlex.split(stripped[5:]), request_id)
        return True
    if stripped.startswith("%cd "):
        target = os.path.expanduser(stripped[4:].strip())
        os.chdir(target)
        emit("stdout", request_id, os.getcwd() + "\n")
        return True
    if stripped.startswith("!"):
        stream_process(stripped[1:], request_id, shell=True)
        return True
    return False


def run_cell(code, request_id, namespace):
    """Execute one cell. Emits result/error frames; returns the status string."""
    if code.lstrip().startswith("%%bash"):
        body = code.split("\n", 1)[1] if "\n" in code else ""
        stream_process(["bash", "-s"], request_id, stdin_text=body)
        return "ok"

    # Single-line magics are handled before compiling, because they are not
    # Python and the compiler would reject them.
    lines = code.split("\n")
    if len(lines) == 1 and run_magic(lines[0], request_id):
        return "ok"

    try:
        tree = ast.parse(code, filename="<kernel>", mode="exec")
    except SyntaxError:
        # No cell frames exist yet, so `format_exception_only` is the whole of
        # the useful message — a traceback here would be entirely this file.
        emit("error", request_id, "".join(traceback.format_exception_only(*sys.exc_info()[:2])))
        return "error"

    # The IPython behaviour worth keeping: if the cell ends in a bare
    # expression, its repr is the answer. Without this, `df.describe()` on the
    # last line prints nothing and the agent adds a print() it should not need.
    tail = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tail = ast.Expression(tree.body.pop().value)

    try:
        if tree.body:
            exec(compile(tree, "<kernel>", "exec"), namespace)
        if tail is not None:
            value = eval(compile(tail, "<kernel>", "eval"), namespace)
            if value is not None:
                # `_` is IPython's name for it and costs nothing to honour.
                namespace["_"] = value
                emit("result", request_id, repr(value))
        return "ok"
    except KeyboardInterrupt:
        # The host's timeout, or the human's abort, arriving as SIGINT. This is
        # the ONLY window in which SIGINT is expected, which is why the kernel
        # survives it instead of dying: the namespace is intact and everything
        # the cell set before the interrupt is still there.
        emit("error", request_id, "KeyboardInterrupt: interrupted at the time limit\n")
        return "cancelled"
    except SystemExit:
        # A cell calling sys.exit() must not take the kernel with it. Reporting
        # it as an ordinary error keeps the session's variables alive.
        emit("error", request_id, format_error())
        return "error"
    except BaseException:
        emit("error", request_id, format_error())
        return "error"


def main():
    namespace = {"__name__": "__kernel__", "__builtins__": __builtins__}
    count = 0

    while True:
        try:
            line = sys.stdin.readline()
        except KeyboardInterrupt:
            # A SIGINT that arrived while idle. Nothing was running, so there is
            # nothing to cancel; going back to the read is the correct response.
            continue
        if not line:
            return  # host closed the pipe

        try:
            request = json.loads(line)
        except ValueError:
            continue  # not ours; the host never sends anything else

        request_id = str(request.get("id", ""))
        code = request.get("code", "")
        count += 1
        emit("started", request_id, count=count)

        saved_out, saved_err = sys.stdout, sys.stderr
        sys.stdout = FrameWriter("stdout", request_id)
        sys.stderr = FrameWriter("stderr", request_id)
        try:
            status = run_cell(code, request_id, namespace)
        except KeyboardInterrupt:
            status = "cancelled"
        finally:
            sys.stdout, sys.stderr = saved_out, saved_err

        emit("done", request_id, count=count, status=status)


if __name__ == "__main__":
    main()
