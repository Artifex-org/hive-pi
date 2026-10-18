#!/usr/bin/env python3
"""Linux native transport fixtures, NOT Pi/bootstrap/authorization readiness.

Trace the direct Node child, including failed kernel entries. Inject failures at
syscall exit; no helper sends on Node's behalf. Never import the SDK/provider.
"""
import ctypes
import errno
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.ptrace.restype = ctypes.c_long
TRACEME, GETREGSET, SETREGSET, SYSCALL, SETOPTIONS = 0, 0x4204, 0x4205, 24, 0x4200
TRACESYSGOOD, EXITKILL, NT_PRSTATUS = 1, 0x100000, 1
PAYLOAD = b"sdk-native-transport-fixture"
NODE_SOURCE = r"""
const assert = require('node:assert/strict');
const path = process.argv[1], mode = process.argv[2];
const ipc = require(path);
assert.equal(typeof ipc.boottimeNanos(), 'bigint');
assert(ipc.boottimeNanos() > 0n);
assert.throws(() => ipc.boottimeNanos(1), {code:'SDK_PRIVATE_TRANSPORT'});
let first = false;
try {
  const body = Buffer.from('sdk-native-transport-fixture');
  switch (mode) {
    case 'missing': ipc.sendBootstrapOnce(); break;
    case 'string': ipc.sendBootstrapOnce('invalid'); break;
    case 'empty': ipc.sendBootstrapOnce(Buffer.alloc(0)); break;
    case 'oversize': ipc.sendBootstrapOnce(Buffer.alloc(4097)); break;
    case 'extra': ipc.sendBootstrapOnce(body, 'extra'); break;
    default: assert.equal(ipc.sendBootstrapOnce(body), true);
  }
  first = true;
} catch (error) {
  assert.equal(error.code, 'SDK_PRIVATE_TRANSPORT');
  assert.equal(error.message, 'SDK private bootstrap unavailable');
}
// A new JS consumer/session and cache deletion cannot restore this binding.
delete require.cache[require.resolve(path)];
const anotherSession = {ipc: require(path)};
assert.throws(() => anotherSession.ipc.sendBootstrapOnce(Buffer.from('second')),
              {code:'SDK_PRIVATE_TRANSPORT'}, 'SDK native reset reopened send');
assert.equal(first, mode === 'success', 'SDK native first outcome changed');
console.log(JSON.stringify({first, secondDenied:true}));
"""


class IOVec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("length", ctypes.c_size_t)]


def ptrace(operation, pid, address=0, data=0):
    ctypes.set_errno(0)
    result = LIBC.ptrace(ctypes.c_uint(operation), ctypes.c_uint(pid),
                         ctypes.c_void_p(address), ctypes.c_void_p(data))
    if result == -1 and ctypes.get_errno():
        raise OSError(ctypes.get_errno(), "native fixture ptrace unavailable; NOT VERIFIED")
    return result


def registers(pid):
    values = (ctypes.c_uint64 * 34)()
    vector = IOVec(ctypes.addressof(values), ctypes.sizeof(values))
    ptrace(GETREGSET, pid, NT_PRSTATUS, ctypes.addressof(vector))
    return values, vector


def set_registers(pid, values, vector):
    ptrace(SETREGSET, pid, NT_PRSTATUS, ctypes.addressof(vector))


def trace_fixture(node, artifact, mode, architecture):
    kind = socket.SOCK_STREAM if mode == "stream" else socket.SOCK_SEQPACKET
    parent, peer = socket.socketpair(socket.AF_UNIX, kind)
    parent.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
    parent.setblocking(False)
    peer.setblocking(mode == "blocking")
    parent_fd, peer_fd = parent.fileno(), peer.fileno()

    def child_setup():
        os.dup2(peer_fd, 3)
        for descriptor in {parent_fd, peer_fd} - {3}:
            os.close(descriptor)
        if mode == "missingfd":
            os.close(3)
        ptrace(TRACEME, 0)

    process = subprocess.Popen(
        [node, "-e", NODE_SOURCE, str(artifact), mode],
        pass_fds=tuple(sorted({3, parent_fd, peer_fd})), preexec_fn=child_setup,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C"},
    )
    peer.close()
    pidfd = os.pidfd_open(process.pid)
    entries = []
    try:
        _, status = os.waitpid(process.pid, 0)
        if not os.WIFSTOPPED(status) or os.WSTOPSIG(status) != signal.SIGTRAP:
            raise AssertionError("direct Node exec trace unavailable; NOT VERIFIED")
        ptrace(SETOPTIONS, process.pid, 0, TRACESYSGOOD | EXITKILL)
        entering, injected = True, False
        if architecture == 62:  # own compiled ELF: x86_64 user_regs_struct
            number, result, arg0, arg2, sendmsg = 15, 10, 14, 12, 46
        else:
            raise AssertionError("unsupported native fixture ELF; NOT VERIFIED")
        while True:
            ptrace(SYSCALL, process.pid)
            _, status = os.waitpid(process.pid, 0)
            if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                process.returncode = os.waitstatus_to_exitcode(status)
                break
            if not os.WIFSTOPPED(status) or os.WSTOPSIG(status) != signal.SIGTRAP | 0x80:
                raise AssertionError("unexpected Node trace stop; NOT VERIFIED")
            values, vector = registers(process.pid)
            if entering and values[number] == sendmsg:
                entries.append({"fd": int(values[arg0]), "flags": int(values[arg2])})
                if mode in {"eintr", "eagain", "short"} and len(entries) == 1:
                    values[number] = (1 << 64) - 1  # skip actual kernel effect
                    set_registers(process.pid, values, vector)
                    injected = True
            elif not entering and injected:
                outcome = {"eintr": -errno.EINTR, "eagain": -errno.EAGAIN, "short": 1}[mode]
                values[result] = outcome % (1 << 64)
                set_registers(process.pid, values, vector)
                injected = False
            entering = not entering
        stdout, stderr = process.stdout.read(), process.stderr.read()
        if process.returncode != 0:
            raise AssertionError(f"native fixture Node assertion failed: {stderr.decode()}")
        report = json.loads(stdout)
        packets = []
        while True:
            try:
                body, controls, flags, _ = parent.recvmsg(4096, socket.CMSG_SPACE(12))
            except BlockingIOError:
                break
            if not body:
                break
            if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                raise AssertionError("fixture credential packet truncated")
            credentials = [struct.unpack("3i", data) for level, kind, data in controls
                           if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS]
            if len(credentials) != 1 or credentials[0][0] != process.pid:
                raise AssertionError("send did not come from retained direct Node child")
            packets.append(body)
        return entries, packets, report
    finally:
        if process.returncode is None:
            process.kill()
            os.waitpid(process.pid, 0)
            process.returncode = -signal.SIGKILL
        os.close(pidfd)
        parent.close()
        process.stdout.close()
        process.stderr.close()


class NativeIPC(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="sdk-native-ipc-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.node = shutil.which("node")
        if not cls.node:
            raise AssertionError("Node unavailable; NOT VERIFIED")
        cls.artifact = Path(cls.temporary.name) / "private-ipc.node"
        subprocess.run([
            cls.node, str(ROOT / "scripts/build-claude-sdk-private-ipc.mjs"),
            "--output", str(cls.artifact),
        ], check=True)
        cls.architecture = struct.unpack_from("<H", cls.artifact.read_bytes(), 18)[0]

    def test_single_send_and_irreversible_refusals(self):
        for mode in ["success", "eintr", "eagain", "short", "blocking", "stream",
                     "missingfd", "missing", "string", "empty", "oversize", "extra"]:
            with self.subTest(mode=mode):
                entries, packets, report = trace_fixture(self.node, self.artifact, mode,
                                                          self.architecture)
                expected = 1 if mode in {"success", "eintr", "eagain", "short"} else 0
                self.assertEqual(len(entries), expected, "SDK native send kernel entry count changed")
                for entry in entries:
                    self.assertEqual(entry["flags"], socket.MSG_DONTWAIT | socket.MSG_NOSIGNAL,
                                     "SDK native nonblocking send flags changed")
                self.assertEqual(packets, [PAYLOAD] if mode == "success" else [],
                                 "SDK native unexpected packet after refusal")
                self.assertTrue(report["secondDenied"], "SDK native reset reopened send")


if __name__ == "__main__":
    # Hard failure, not skip/green, when ptrace/compiler/platform is unavailable.
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(
        TimeoutError("native fixture deadline exceeded; NOT VERIFIED")))
    signal.alarm(30)
    unittest.main(verbosity=2)
