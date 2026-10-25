"""Local observation only. Never prints context or answers a native approval."""
import json
import os
import socket
import sys


def main():
    raw = sys.stdin.buffer.read(2 * 1024 * 1024)
    message = json.loads(raw)
    fields = (
        "hook_event_name", "session_id", "agent_id", "agent_type", "source", "reason",
        "prompt", "prompt_id", "last_assistant_message", "stop_hook_active", "model",
        "teammate_name", "team_name", "task_id", "task_subject", "tool_name",
        "notification_type", "message", "background_tasks", "session_crons", "tool_use_id",
        "permission_mode",
    )
    event = {key: message[key] for key in fields if key in message}
    event["token"] = os.environ["NAW_HOOK_TOKEN"]
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(1)
        connection.connect(os.environ["NAW_HOOK_SOCKET"])
        connection.sendall((json.dumps(event) + "\n").encode("utf-8"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Observation failure must neither disclose content nor block native work.
        pass
