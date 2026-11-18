"""Run the real PTY worker under a deterministic OS schedule.

All process and signal calls use synthetic identities. No real PID is signalled;
the kernel-reap boundary and group reuse are injected rather than forced.
"""
import io
import json
import pathlib
import sys
import types

host, scenario = sys.argv[1:]
namespace = {"__name__": "scheduled_pty_worker"}
exec(compile(pathlib.Path(host).read_text(), host, "exec"), namespace)
state = {"clock": 0.0, "reaped": False, "killed": False,
         "group_checks": 0, "loops": 0, "injected": False, "child_alive": True}
signals, handlers = [], {}
packet = (json.dumps({"argv": ["synthetic-not-executed"], "cwd": "/"}) + "\n").encode()
if scenario in ("stubborn-then-reuse", "zombie-eperm", "term-zombie-eperm", "term-live-eperm", "term-surviving-group-eperm"):
    packet += b'{"type":"stop"}\n'


class Selector:
    def register(self, *args):
        pass

    def unregister(self, *args):
        pass

    def close(self):
        pass

    def select(self, timeout):
        state["clock"] += timeout
        state["loops"] += 1
        assert state["loops"] <= 30, "Worker did not finish the finite schedule"
        if scenario == "signal-before-natural-reap" and not state["injected"]:
            state["injected"] = True
            handlers[15](15, None)
        return []


def killpg(pid, sig):
    assert pid == 424242, "Only the synthetic PTY group may be addressed"
    if sig:
        signals.append({"signal": sig, "at": state["clock"],
                        "target": "foreign-reused-group" if state["reaped"] else "owned-group"})
        if sig == 15 and scenario in ("term-zombie-eperm", "term-live-eperm", "term-surviving-group-eperm"):
            raise PermissionError(1, "Synthetic group signal denied")
        if sig == 9:
            state["killed"] = True
            state["child_alive"] = False
        return
    if scenario == "signal-before-natural-reap":
        if not state["child_alive"]:
            raise ProcessLookupError()
        return
    if state["reaped"]:
        state["group_checks"] += 1
        if scenario == "term-surviving-group-eperm":
            raise PermissionError(1, "Synthetic surviving group denied")
        # A reused identity may still exist, but must never receive TERM/KILL.
        if state["group_checks"] > 2:
            raise ProcessLookupError()
    elif scenario == "zombie-eperm":
        raise PermissionError()


def waitpid(pid, flags):
    assert pid == 424242 and flags == 1
    if scenario == "signal-before-natural-reap":
        state["reaped"] = True
        return pid, 0
    if scenario == "signal-after-reap":
        state["reaped"] = True
        state["injected"] = True
        # The kernel freed the identity; the caller has not set reaped=True.
        handlers[15](15, None)
        return pid, 0
    if scenario == "signal-while-alive" and not state["injected"]:
        state["injected"] = True
        handlers[15](15, None)
        return 0, 0
    if scenario in ("zombie-eperm", "term-zombie-eperm", "term-surviving-group-eperm") or state["killed"]:
        state["reaped"] = True
        return pid, 0
    return 0, 0


output = io.StringIO()
namespace.update(
    os=types.SimpleNamespace(pipe=lambda: (80, 81), close=lambda *args: None,
                             read=lambda fd, size: packet if fd == 0 else b"1",
                             killpg=killpg, waitpid=waitpid,
                             waitstatus_to_exitcode=lambda status: 0, WNOHANG=1),
    pty=types.SimpleNamespace(fork=lambda: (424242, 90)),
    fcntl=types.SimpleNamespace(ioctl=lambda *args: None),
    selectors=types.SimpleNamespace(DefaultSelector=Selector, EVENT_READ=1),
    signal=types.SimpleNamespace(SIGTERM=15, SIGKILL=9,
                                 signal=lambda sig, handler: handlers.__setitem__(sig, handler)),
    time=types.SimpleNamespace(monotonic=lambda: state["clock"]),
    sys=types.SimpleNamespace(stdin=types.SimpleNamespace(fileno=lambda: 0), stdout=output))
try:
    namespace["main"]()
finally:
    print(json.dumps({"scenario": scenario, "signals": signals, "schedule": state,
                      "records": [json.loads(line) for line in output.getvalue().splitlines()]}))
