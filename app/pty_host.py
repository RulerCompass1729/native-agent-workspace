"""Own one native terminal until explicitly stopped; JSON messages over stdio."""
import base64
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import sys
import termios
import time


def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


def main():
    # Keep configuration and later commands on one unbuffered byte stream.
    # Buffered readline can read ahead into an input/resize packet, which a
    # subsequent os.read would never see. Preserve every byte after the line.
    pending = b""
    while b"\n" not in pending:
        data = os.read(sys.stdin.fileno(), 65536)
        if not data:
            raise ValueError("Missing terminal configuration")
        pending += data
        if len(pending) > 2 * 1024 * 1024:
            raise ValueError("Oversized terminal configuration")
    line, pending = pending.split(b"\n", 1)
    config = json.loads(line)
    # forkpty's parent can return before the child has made its own session.
    # Do not publish started or send group signals until that child-side work
    # is done. EOF also releases the parent if setup fails before the receipt.
    ready_read, ready_write = os.pipe()
    try:
        pid, fd = pty.fork()
    except BaseException:
        os.close(ready_read)
        os.close(ready_write)
        raise
    if pid == 0:
        os.close(ready_read)
        os.write(ready_write, b"1")
        os.close(ready_write)
        os.chdir(config["cwd"])
        environment = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
        environment.update(config.get("env", {}))
        os.execvpe(config["argv"][0], config["argv"], environment)
    os.close(ready_write)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    try:
        os.read(ready_read, 1)
    finally:
        os.close(ready_read)
    emit({"type": "started", "pid": pid})
    selector = selectors.DefaultSelector()
    selector.register(fd, selectors.EVENT_READ, "pty")
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "input")
    reaped = False
    stop_requested = False
    stop_deadline = None
    killed = False
    exit_code = None

    def terminate():
        nonlocal stop_deadline
        if reaped or stop_deadline is not None:
            return
        # Preserve the former caller's full five-second graceful-exit budget.
        stop_deadline = time.monotonic() + 5.0
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def request_stop(*_):
        nonlocal stop_requested
        # waitpid may already have released the PID when Python dispatches a
        # signal, before the caller records reaped=True. Only the main loop
        # may signal the owned group; this callback must never use its old ID.
        stop_requested = True

    signal.signal(signal.SIGTERM, request_stop)
    try:
        running = True
        while running:
            if stop_requested:
                terminate()
            # Drain retained frames before waiting for another fd event; the
            # writer may already be idle after sending configuration + input.
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                command = json.loads(line)
                if command["type"] == "input":
                    data = command["data"].encode("utf-8")
                    while data:
                        data = data[os.write(fd, data):]
                elif command["type"] == "resize":
                    cols = max(20, min(400, int(command["cols"])))
                    rows = max(5, min(200, int(command["rows"])))
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                elif command["type"] == "stop":
                    terminate()
            for key, _ in selector.select(0.5):
                if key.data == "pty":
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        data = b""
                    if not data:
                        # Closing the terminal stream does not prove process exit.
                        selector.unregister(fd)
                    else:
                        emit({"type": "data", "data": base64.b64encode(data).decode("ascii")})
                else:
                    data = os.read(sys.stdin.fileno(), 65536)
                    if not data:
                        selector.unregister(sys.stdin.fileno())
                        terminate()
                        continue
                    pending += data
                    if len(pending) > 2 * 1024 * 1024:
                        raise ValueError("Oversized terminal command")
            # select/read may dispatch SIGTERM after the loop's first check.
            # Handle that request while the unreaped leader still owns its ID.
            if stop_requested:
                terminate()
            if stop_deadline is not None:
                if not reaped and time.monotonic() < stop_deadline:
                    try:
                        os.killpg(pid, 0)
                        continue
                    except (ProcessLookupError, PermissionError):
                        # On macOS a zombie-only group returns EPERM. Reap it
                        # promptly, but still require group absence below.
                        # A live group we cannot signal stays unconfirmed.
                        finished, status = os.waitpid(pid, os.WNOHANG)
                        if not finished:
                            continue
                        reaped = True
                        exit_code = os.waitstatus_to_exitcode(status)
                if not reaped and not killed:
                    # Keep our direct child unreaped until the last signal:
                    # its PID (and thus this PTY's group ID) cannot be reused.
                    # Descendants can survive even when the leader took TERM.
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        # macOS can return EPERM for a zombie-only group.
                        # Reaping plus ESRCH below, never EPERM, proves exit.
                        pass
                    killed = True
            if not reaped:
                finished, status = os.waitpid(pid, os.WNOHANG)
                if finished:
                    reaped = True
                    exit_code = os.waitstatus_to_exitcode(status)
            if reaped:
                # A callback dispatched inside waitpid cannot safely signal the
                # released identity. It still requires group absence: never
                # turn that late stop into a false numeric exit confirmation.
                if stop_deadline is not None or stop_requested:
                    try:
                        os.killpg(pid, 0)
                        continue
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        continue
                # An explicit stop is confirmed only after the owned group is
                # gone, not merely after waitpid reaps its leader.
                emit({"type": "exit", "code": exit_code})
                return
    finally:
        if not reaped:
            terminate()
        selector.close()
        os.close(fd)
    emit({"type": "exit", "code": None})


if __name__ == "__main__":
    main()
