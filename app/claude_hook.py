"""Local observation. Only the --ask hook may print: the answer the person gave in
the chat view to a native AskUserQuestion, or its refusal when they stop the turn.
It never answers any other tool's permission."""
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
        "permission_mode", "effort", "transcript_path",
    )
    event = {key: message[key] for key in fields if key in message}
    event["token"] = os.environ["NAW_HOOK_TOKEN"]
    ask = "--ask" in sys.argv and message.get("tool_name") == "AskUserQuestion"
    if ask:
        # The chat view may answer this question; NAW replies with answers or
        # nothing. Nothing, a timeout or any failure lets the native dialog ask.
        event["ask"] = True
        event["questions"] = (message.get("tool_input") or {}).get("questions")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(1)
        connection.connect(os.environ["NAW_HOOK_SOCKET"])
        connection.sendall((json.dumps(event) + "\n").encode("utf-8"))
        if not ask:
            return
        connection.settimeout(3550)
        reply = b""
        while not reply.endswith(b"\n") and len(reply) < 2 * 1024 * 1024:
            chunk = connection.recv(65536)
            if not chunk:
                return
            reply += chunk
    reply = json.loads(reply)
    if reply.get("stop") is True:
        # The person stopped the turn in NAW before answering.
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": "The person stopped this turn before answering."}}))
        return
    answers = reply.get("answers")
    if isinstance(answers, dict) and answers and all(isinstance(k, str) and isinstance(v, str) for k, v in answers.items()):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow",
            "updatedInput": {"questions": event["questions"], "answers": answers}}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Observation failure must neither disclose content nor block native work.
        pass
