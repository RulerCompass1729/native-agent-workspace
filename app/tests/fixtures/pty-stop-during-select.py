"""Isolated real PTY: TERM during select, natural leader exit, stubborn child."""
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time

with tempfile.TemporaryDirectory(prefix="naw-pty-stop-") as folder:
    root = pathlib.Path(folder)
    fixture = pathlib.Path(__file__).with_name("pty-stop-tree.py")
    worker = subprocess.Popen([sys.executable, "-B", sys.argv[1]],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True)
    receipt = None
    try:
        worker.stdin.write(json.dumps({"argv": [sys.executable, "-B", str(fixture), folder],
                                       "cwd": folder}) + "\n")
        worker.stdin.flush()
        deadline = time.monotonic() + 5
        while not (root / "receipt.json").exists():
            assert time.monotonic() < deadline, "Fixture readiness timeout"
            time.sleep(.01)
        receipt = json.loads((root / "receipt.json").read_text())
        assert receipt["leader"] == receipt["pgid"]
        time.sleep(.1)
        started = time.monotonic()
        worker.send_signal(signal.SIGTERM)
        (root / "exit-leader").touch()
        worker.wait(timeout=9)
        records = [json.loads(line) for line in worker.stdout.read().splitlines()]
        try:
            os.kill(receipt["child"], 0)
            alive = True
        except ProcessLookupError:
            alive = False
        print(json.dumps({"elapsed": time.monotonic() - started, "childAliveAfterExit": alive,
                          "records": records, "workerReturnCode": worker.returncode,
                          "stderr": worker.stderr.read()}), flush=True)
    finally:
        # The child has an independent cleanup path even when the old worker
        # incorrectly confirms exit. Only this fixture's owned processes exist.
        (root / "cleanup").touch()
        (root / "exit-leader").touch()
        if worker.poll() is None:
            worker.stdin.close()
            worker.wait(timeout=9)
        if receipt:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                try:
                    os.kill(receipt["child"], 0)
                except ProcessLookupError:
                    break
                time.sleep(.05)
            else:
                raise AssertionError("Owned fixture child cleanup not confirmed")
