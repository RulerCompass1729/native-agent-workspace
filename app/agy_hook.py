"""Local read-only lifecycle and MCP call-origin observer for Antigravity CLI (`agy`) hooks.
No-op outside NAW-launched sessions (requires both NAW_HOOK_TOKEN and NAW_HOOK_SOCKET).
Never sends user prompts, raw message bodies, tool arguments or transcript bodies."""
import hashlib
import json
import os
import socket
import sys


def respond(event_name):
    if event_name == "PreToolUse":
        sys.stdout.write(json.dumps({"decision": "allow"}) + "\n")
    else:
        sys.stdout.write("{}\n")


def main():
    token = os.environ.get("NAW_HOOK_TOKEN")
    sock_path = os.environ.get("NAW_HOOK_SOCKET")
    raw = sys.stdin.buffer.read(2 * 1024 * 1024)
    message = json.loads(raw) if raw.strip() else {}
    event_name = message.get("hookEventName", "")
    if not token or not sock_path:
        respond(event_name)
        return
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
    if event_name in ("PreToolUse", "PostToolUse"):
        tool_call = message.get("toolCall") or {}
        tool_name = tool_call.get("name") or ""
        if not tool_name.endswith("workspace_message"):
            respond("")
            return
        if isinstance(tool_call.get("id"), str):
            event["toolCallId"] = tool_call["id"]
        event["toolName"] = tool_name
        if event_name == "PreToolUse":
            args = tool_call.get("args") or {}
            if isinstance(args.get("recipient_id"), str):
                event["recipientId"] = args["recipient_id"]
            if isinstance(args.get("message"), str):
                event["messageHash"] = hashlib.sha256(args["message"].encode("utf-8")).hexdigest()
    event["token"] = token
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(1)
        connection.connect(sock_path)
        connection.sendall((json.dumps(event) + "\n").encode("utf-8"))
    respond(event_name)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Observation failure must neither disclose content nor block native work.
        sys.stdout.write("{}\n")
