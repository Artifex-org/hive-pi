# kernel

A persistent Python interpreter, as **one tool among many**.

## Why, and what this is not

"Persistent kernels — not adopted" was the right call for what was proposed then: a kernel as the *primary action surface*, with file edits, search and delegation all routed through `exec`. That trades a reviewed, guarded, diffable tool set for a Python string, and it puts this harness's own protections — the worktree guard, the LSP-backed edit path, the subagent trust gate — behind an interpreter that knows nothing about any of them.

What is adopted here is the scoped version. The kernel is **one tool**. It edits nothing on the harness's behalf, spawns no subagents, and every existing path stays exactly where it is. Two things it buys that nothing else here does:

1. **Code execution as a tool call.** Write a script, run it, read a summary. The intermediate results — the dataframe, the 4,000-row query, the parsed log — never enter the transcript.
2. **Variables that survive turns *and* compaction.** The process is not in the context window, so a 300MB object costs nothing to keep, and the agent slices it programmatically instead of pasting it and re-reading it.

Claim 1 rests entirely on the output discipline below. **Without the spill, the token argument for a kernel does not hold** — every byte the cell prints is billed to the context on the way past, and the feature degrades into an expensive `bash` that also holds state.

## The shape

One tool, `kernel`, with three parameters:

| | |
| --- | --- |
| `code` | Python, run in a namespace that persists across calls |
| `timeout_seconds` | default 30, clamped to 1..3600 |
| `reset` | discard the interpreter and start a fresh one first |

Magics, kept to four because each is something you cannot write in the cell body: `%pip …` (streams, and installs into *the interpreter running the cell*), `%cd …`, `!command`, and `%%bash` as a cell's first line. Anything beyond that and this becomes a second bash tool, which is explicitly not what it is for.

## Transport: NDJSON over a pipe, not ZeroMQ

Jupyter speaks ZeroMQ over unix sockets, and a unix socket is exactly what cannot be used: **srt's seccomp filter blocks `socket(AF_UNIX)`**. That is measured, not theorised — it is what killed `@playwright/mcp` in this harness (HIV-1636), and `devservices/pg.ts` carries the same scar (`unix_socket_directories=''`, or Postgres will not start).

So the transport is one JSON object per line over the stdin/stdout of a plain `python -u runner.py`. The host sends `{id, code, timeout}`; the runner answers with `started`, `stdout`, `stderr`, `result`, `error` and `done` frames, carrying an execution counter and a terminal status.

**A stray byte must never wedge the session.** The runner replaces `sys.stdout` for the duration of a cell, so ordinary `print` comes back wrapped. But a cell may `subprocess.Popen` something that inherits fd 1 and writes raw bytes between frames — and closing that hole would mean giving up `!cmd` and `%%bash`. So an unparseable line is **not an error**: it is stdout that lost its envelope, and `parseFrame` says so. Throwing there would let one badly-behaved child stop the kernel answering for the rest of the session.

The rule runs the other way too. A cell that *prints* something frame-shaped must not be able to forge one, so a frame counts only when its `id` is the id of the request in flight. Both rules are pinned in `test/kernel-protocol.test.ts`.

## Output discipline is the feature

Every result goes through two limits before the model sees it:

- **~10 lines, tail not head, long lines clamped at 200 characters** (`shapeOutput`), plus a 2KB byte ceiling so that 300 short lines are still 300 lines.
- **Everything else is spilled** through the artifact contract (`../artifacts/store.ts`), and the reply names the ref and the file.

Tail, not head, for the reason `background/jobs.ts` gives: a traceback prints last, a summary prints last, and `renderBody` deliberately puts the error section at the bottom so a tail preview always contains it. The most misleading thing this extension could return is the first ten lines of a 400-line print with the exception cut off.

The shaping decision is this extension's (lines and line width, not just bytes); the *storing* decision is the artifact module's. `spill` is called only once the preview is known to be partial, with `previewBytes: 0` so it always writes — which is why `print(2+2)` does not produce an artifact and 500 rows do.

**The "output truncated" notice is driven by the preview, never by whether an artifact was written.** `spill` legitimately returns no ref when the session's 256-artifact cap is reached or the write fails, and a notice gated on the ref would fall silent in exactly the cases where the missing bytes are unrecoverable — a partial answer presented as a whole one, which is the worst thing this extension could return.

The artifact directory is resolved by `resolveArtifactDir`, which owns the order: an **inherited** `PI_ARTIFACT_DIR` first, then this session's own jsonl path with `.jsonl` stripped, then a per-process directory under the OS temp dir (sessions are not always persisted). The kernel is spawned with `PI_ARTIFACT_DIR` set to whatever that resolved to, so a `pi` the cell itself launches writes into the same store.

## Interpreter resolution

In order, first that answers the version probe:

1. `$PI_KERNEL_PYTHON`
2. `$VIRTUAL_ENV/bin/python` — a session working inside a project's venv computes against *that* project's packages
3. `~/.hive/tools/kernel-venv/bin/python` — the managed venv, installed by `workstation/bin/install-kernel-venv`
4. `python3`, then `python`

"Answers the probe" means it is **executed** (`sys.version_info >= (3, 10)`), not that its filename or `--version` output was parsed. `python3` on a long-lived box has meant anything from 3.6 to 3.14.

With nothing usable, the tool returns an install hint naming the script and every candidate it looked at — the shape `devservices/index.ts` uses, for its measured reason: a bare "not found" leaves the agent with no next move, and three sessions abandoned their task rather than recovering from one (HIV-1966). A sandboxed session cannot download an interpreter; only the host can.

The managed venv exists even though the system fallback works, because `%pip install` against a system Python is either refused (PEP 668, the default on Arch and on Debian since bookworm) or pollutes an interpreter other things depend on.

### The bug this shipped, for one run

`VERSION_PROBE` was first built with `JSON.stringify(MIN_PYTHON)` — `[3,10]`, a Python **list**. `sys.version_info >= [3, 10]` raises `TypeError`, the probe exited non-zero, and every interpreter on the machine was rejected as too old. `tsc` was clean and every resolution test passed, because they all inject a fake probe. Only the headless run caught it. The lesson is the house one — a typecheck is not a smoke test — with a corollary: a string built for another language is not checked by this one, so `usablePython` now has a test that executes the real probe.

## Environment: an allowlist

`PATH`, `HOME`, `LANG`, `VIRTUAL_ENV`, `PYTHONPATH`, plus anything prefixed `LC_`, `XDG_` or `PI_`. Nothing else, so no provider key reaches the kernel.

`background/index.ts` passes `process.env` wholesale to its shell, which is defensible there: the agent chose that command and a shell is the point. Here the agent is running code in a namespace that persists across turns. A denylist would need updating every time a credential is invented; an allowlist is wrong only in the direction of "the cell cannot see something", which is a message the model can act on.

## Lifetime, cancellation and reaping

One kernel per **(session, cwd, interpreter)**. Not one per session — an agent that `cd`s into a sibling worktree and keeps computing in a namespace whose relative paths point at the old one is a debugging session nobody wants. Not one per call — surviving the turn is the whole feature. The interpreter is in the key so switching venvs cannot silently keep the old site-packages.

**Timeout and abort send SIGINT to the process group.** `runner.py` catches the `KeyboardInterrupt`, reports `cancelled`, and **stays alive with its namespace intact** — a cell that overran has usually already set the variables that mattered, and killing the interpreter would throw them away for nothing. Only if it does not answer within a 2s grace do we conclude it is wedged and SIGKILL the group; the next call then finds it dead and spawns a fresh one.

The **group**, always, because `!cmd` and `%%bash` start children and signalling only the interpreter leaves them running with nothing watching them — a measured defect in this house (agent sidecars OOMing a pod hours after the run that spawned them). Kernels are spawned `detached` so the turn's abort cannot kill them, which means **`session_shutdown` is the only thing that reaps them**, and it is not optional.

**One cell at a time.** The tool declares `executionMode: "sequential"` (pi batches tool calls in parallel by default), and `Kernel.execute` refuses a second concurrent cell outright. The declaration is a request to a scheduler this extension does not own; without the refusal, two parallel calls fold the first's frames into the second as stray output and the first resolves only when its own timeout fires — two plausible, wrong answers.

The reaping test does not repeat the two mistakes that made `background`'s equivalent vacuous twice: it uses a **fresh pid-file path per run** (a leftover file made the old one read a stale pid, so `kill(pid, 0)` threw at once and it reported success without reaping anything), and its deadline sits **below the SIGKILL sweep** (a generous one passed with the group kill deliberately broken, because the grandchild died late for unrelated reasons). Verified by sabotage: with `process.kill(-pid)` changed to `process.kill(pid)`, the test fails.

There is a **second** reaping test that drives the real `session_shutdown` handler through `fake-pi`, because the first one calls `dispose()` directly and would stay green if the `pi.on("session_shutdown", …)` line were deleted — the same vacuous shape one level up. Also verified by sabotage: with the handler emptied, it fails. Closing the pipe on exit does make a well-behaved runner quit, but it does not reap the grandchildren of a wedged cell; the group kill behind this event is the only thing that does.

There is no separate state directory. If one is ever added it must be **per-session**, never a shared or pid-keyed path — a sandbox has its own PID namespace, so `process.pid` is a low repeated number across live sessions and collides. `devservices/pg.ts`'s `dataDirFor` header has the measured failure (HIV-1966).

## Which guard covers this — and which does not

`guards-bridge` matches a **set of shell tools** and reads their `command` parameter, handing it to the bridged `pre-bash-dispatch.sh`. That hook is a command-string matcher encoding machine-specific policy (kubectl contexts, which checkouts are guarded).

**That path deliberately does not apply here.** This tool's parameter is `code`. Adding `kernel` to `SHELL_TOOLS` would make the bridge look for a `command` that does not exist, find nothing, and return early — a guard that reports healthy and enforces nothing, which is worse than an absent one. Feeding a Python cell to a bash-command matcher would produce confident nonsense in the other direction.

What does apply:

- **The capability declaration.** Registered via `registerGuardedTool` with `executes: true`, so `test/tool-capability.test.ts` accounts for it and a reader can grep every execution site. `writes` names *parameters* holding paths, and a Python cell has none, so the declaration carries a `writesExemptBecause` saying exactly that rather than an empty field the conformance test rejects.
- **The sandbox boundary** the session already runs inside, which is what bounds a cell's reach in a launched agent.
- **Not the worktree guard.** A cell can write a file in a pull-only checkout. So can `bash` in a factory container, where the hook does not exist and failing open is the correct behaviour — but it is stated here rather than left to be inferred from an absence.

## Deliberate limits

- **No mode gate.** Unlike `background`, the result is awaited, so there is nothing that needs a live session to land in later. The kernel works in `-p`.
- **No persistence across restarts.** Kernels die with the session, by design.
- **Not a shell, not an editor, not a router.** File edits, search and delegation keep their own tools, which are guarded, reviewed and better at it. The prompt guidelines say so, because the pull toward routing everything through `exec` is exactly what the original decision rejected.
