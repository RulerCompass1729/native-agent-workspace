"""Local read-only lifecycle observer for Antigravity CLI (`agy`) hooks.
No-op outside NAW-launched sessions (requires both NAW_HOOK_TOKEN and NAW_HOOK_SOCKET).
Never sends user prompts, tool arguments or transcript bodies."""
import json
import os
import socket
import sys


def main():
    token = os.environ.get("NAW_HOOK_TOKEN")
    sock_path = os.environ.get("NAW_HOOK_SOCKET")
    if not token or not sock_path:
        sys.stdout.write("{}\n")
        return
    raw = sys.stdin.buffer.read(2 * 1024 * 1024)
    message = json.loads(raw)
    fields = (
        "hookEventName",
        "conversationId",
        "modelName",
        "terminationReason",
        "fullyIdle",
        "stepIdx",
        "invocationNum",
        "initialNumSteps",
        "transcriptPath",
    )
    event = {key: message[key] for key in fields if key in message}
    if message.get("error"):
        event["hasError"] = True
    event["token"] = token
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(1)
        connection.connect(sock_path)
        connection.sendall((json.dumps(event) + "\n").encode("utf-8"))
    sys.stdout.write("{}\n")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Observation failure must neither disclose content nor block native work.
        sys.stdout.write("{}\n")
