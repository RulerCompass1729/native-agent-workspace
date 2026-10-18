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


def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


def main():
    config = json.loads(sys.stdin.buffer.readline())
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(config["cwd"])
        environment = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
        environment.update(config.get("env", {}))
        os.execvpe(config["argv"][0], config["argv"], environment)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    emit({"type": "started", "pid": pid})
    selector = selectors.DefaultSelector()
    selector.register(fd, selectors.EVENT_READ, "pty")
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "input")
    pending = b""

    def terminate(*_):
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, terminate)
    try:
        running = True
        while running:
            for key, _ in selector.select(0.5):
                if key.data == "pty":
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        running = False
                        break
                    if not data:
                        running = False
                        break
                    emit({"type": "data", "data": base64.b64encode(data).decode("ascii")})
                else:
                    data = os.read(sys.stdin.fileno(), 65536)
                    if not data:
                        terminate()
                        running = False
                        break
                    pending += data
                    if len(pending) > 2 * 1024 * 1024:
                        raise ValueError("Oversized terminal command")
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
            finished, status = os.waitpid(pid, os.WNOHANG)
            if finished:
                emit({"type": "exit", "code": os.waitstatus_to_exitcode(status)})
                return
    finally:
        terminate()
        selector.close()
        os.close(fd)
    emit({"type": "exit", "code": None})


if __name__ == "__main__":
    main()
