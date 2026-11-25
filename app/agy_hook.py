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


def no_decision(raw):
    # agy reads {} from PreToolUse as a denial; only empty output leaves the call to its own permissions.
    try:
        event_name = json.loads(raw).get("hookEventName")
    except Exception:
        return
    if event_name and event_name != "PreToolUse":
        sys.stdout.write("{}\n")


def main():
    token = os.environ.get("NAW_HOOK_TOKEN")
    sock_path = os.environ.get("NAW_HOOK_SOCKET")
    raw = sys.stdin.buffer.read(2 * 1024 * 1024)
    if not token or not sock_path:
        no_decision(raw)
        return
    message = json.loads(raw) if raw.strip() else {}
    event_name = message.get("hookEventName", "")
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
        raw_args = tool_call.get("args") or {}
        if not isinstance(raw_args, dict):
            raw_args = {}
        is_workspace_msg = False
        call_args = raw_args
        if tool_name == "call_mcp_tool":
            srv = raw_args.get("ServerName") or raw_args.get("server_name") or ""
            tname = raw_args.get("ToolName") or raw_args.get("tool_name") or ""
            if srv == "naw_workspace" and tname == "workspace_message":
                is_workspace_msg = True
                nested = raw_args.get("Arguments") if "Arguments" in raw_args else raw_args.get("arguments")
                if isinstance(nested, str):
                    try:
                        nested = json.loads(nested)
                    except Exception:
                        nested = {}
                call_args = nested if isinstance(nested, dict) else {}
        elif tool_name.endswith("workspace_message"):
            is_workspace_msg = True
        if not is_workspace_msg:
            respond("")
            return
        if isinstance(tool_call.get("id"), str):
            event["toolCallId"] = tool_call["id"]
        event["toolName"] = "workspace_message"
        if event_name == "PreToolUse":
            if isinstance(call_args.get("recipient_id"), str):
                event["recipientId"] = call_args["recipient_id"]
            if isinstance(call_args.get("message"), str):
                event["messageHash"] = hashlib.sha256(call_args["message"].encode("utf-8")).hexdigest()
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
