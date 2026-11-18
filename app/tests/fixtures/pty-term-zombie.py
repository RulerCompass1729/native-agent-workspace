"""Hold the real host before its first stop until its owned child is a zombie.

Only this host's direct child is inspected/signalled/reaped. macOS supplies the
real EPERM; elsewhere inject that errno after checking the same real zombie.
"""
import errno
import importlib.util
import json
import os
import signal
import subprocess
import sys
import time

os.set_inheritable(3, False)
spec = importlib.util.spec_from_file_location("owned_pty_host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
emit, killpg, waitpid, read = host.emit, os.killpg, os.waitpid, os.read
owned_pid = None
cleanup = False
input_scheduled = False


def trace(value):
    os.write(3, (json.dumps(value) + "\n").encode())


def scheduled_read(fd, size):
    global input_scheduled
    data = read(fd, size)
    if fd == 0 and not input_scheduled:
        # The real Terminal writes configuration followed immediately by stop.
        # Deliver both in one read so the host handles stop before natural reap.
        while data.count(b"\n") < 2:
            more = read(fd, size)
            assert more, "Configuration and stop are both required"
            data += more
        input_scheduled = True
    return data


def held_emit(value):
    global owned_pid
    emit(value)
    if value["type"] != "started":
        return
    owned_pid = value["pid"]
    deadline = time.monotonic() + 4
    while True:
        state = subprocess.check_output(
            ["/bin/ps", "-p", str(owned_pid), "-o", "stat="], text=True, timeout=1).strip()
        if state.startswith("Z"):
            trace({"phase": "zombie", "pid": owned_pid, "stat": state})
            return
        assert time.monotonic() < deadline, "Owned synthetic child did not exit"
        time.sleep(.01)


def traced_killpg(pid, sig):
    assert pid == owned_pid, "Only the unreaped owned group is a signal target"
    try:
        result = killpg(pid, sig)
    except OSError as error:
        trace({"phase": "killpg", "signal": sig, "errno": error.errno})
        raise
    trace({"phase": "killpg", "signal": sig, "errno": 0})
    if sig == signal.SIGTERM and sys.platform != "darwin":
        trace({"phase": "portable-eperm"})
        raise PermissionError(errno.EPERM, "macOS zombie-only group schedule")
    return result


def traced_waitpid(pid, flags):
    if pid != owned_pid:
        return waitpid(pid, flags)  # subprocess owns its exact ps child as well.
    result = waitpid(pid, flags)
    trace({"phase": "waitpid", "pid": result[0], "status": result[1], "cleanup": cleanup})
    return result


host.emit = held_emit
os.killpg, os.waitpid = traced_killpg, traced_waitpid
os.read = scheduled_read
try:
    host.main()
finally:
    # Old-code failures must not orphan even an already dead owned child.
    cleanup = True
    if owned_pid:
        try:
            traced_waitpid(owned_pid, 0)
        except ChildProcessError:
            pass
