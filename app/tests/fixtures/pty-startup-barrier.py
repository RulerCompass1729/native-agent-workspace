"""Test-only scheduling at fork-before-setsid; no provider or model is started."""
import errno
import importlib.util
import json
import os
import pty
import sys

host_pid = os.getpid()
owned_pid = None
master_fd = None
reported_read = False
read = os.read
killpg = os.killpg
fork = pty.fork
os.set_inheritable(3, False)
os.set_inheritable(4, False)


def trace(value):
    os.write(4, (json.dumps(value) + "\n").encode())


def child_barrier():
    trace({"phase": "before-session", "pid": os.getpid(), "pgid": os.getpgrp()})
    if len(sys.argv) > 2 and sys.argv[2] == "fail-setup":
        os._exit(17)
    read(3, 1)


def portable_fork():
    raise OSError(errno.ENOSYS, "Exercise the standard library's portable PTY fork")


def traced_fork():
    global owned_pid, master_fd
    pid, fd = fork()
    if pid:
        owned_pid, master_fd = pid, fd
        trace({"phase": "fork-returned", "pid": pid})
    return pid, fd


def traced_read(fd, size):
    global reported_read
    # Let an ownership handshake finish once the host is actually waiting for
    # its child. On the old host the failed group signal releases the barrier.
    if os.getpid() == host_pid and owned_pid and fd not in (0, 3, 4, master_fd) and not reported_read:
        reported_read = True
        trace({"phase": "waiting-for-child", "pid": owned_pid})
    return read(fd, size)


def traced_killpg(pid, sig):
    try:
        return killpg(pid, sig)
    except ProcessLookupError:
        trace({"phase": "missing-group", "pid": pid, "pgid": os.getpgid(pid)})
        raise


os.forkpty = portable_fork
os.register_at_fork(after_in_child=child_barrier)
pty.fork = traced_fork
os.read = traced_read
os.killpg = traced_killpg
spec = importlib.util.spec_from_file_location("owned_pty_host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
host.main()
