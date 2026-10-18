"""Check two subscriptions to an already loaded, idle Codex thread.

This diagnostic never creates a thread, starts a turn, answers an approval,
reads credentials, or stops the server. It is not a product session manager.
"""

import argparse
import asyncio
import collections
import json
import os
from pathlib import Path
import stat
import uuid

from websockets.asyncio.client import unix_connect


METHODS = frozenset({
    "initialize", "thread/loaded/list", "thread/read", "thread/resume",
})


class ProbeError(Exception):
    """A deliberately sanitized diagnostic safe to print."""


def private_socket(value):
    path = Path(value)
    if not path.is_absolute():
        raise ProbeError("Use an absolute Unix socket path.")
    try:
        # Codex may publish the requested socket as a symlink. Validate both
        # private directories, then connect to the resolved destination.
        entry_stat, parent_stat = path.lstat(), path.parent.stat()
        resolved = path.resolve(strict=True)
        socket_stat, resolved_parent_stat = resolved.stat(), resolved.parent.stat()
    except OSError:
        raise ProbeError("Socket or parent directory is unavailable.") from None
    if not stat.S_ISSOCK(socket_stat.st_mode):
        raise ProbeError("The target is not a Unix socket.")
    if any(item.st_uid != os.getuid() for item in (
        entry_stat, parent_stat, socket_stat, resolved_parent_stat,
    )):
        raise ProbeError("Socket and its parent must belong to the current user.")
    if any(stat.S_IMODE(item.st_mode) & 0o077 for item in (parent_stat, resolved_parent_stat)):
        raise ProbeError("Socket directory must deny group and other access.")
    return str(resolved)


class Client:
    def __init__(self, ws):
        self.ws = ws
        self.sequence = 0
        self.pending = {}
        self.events = collections.Counter()
        self.calls = collections.Counter()
        self.reader = asyncio.create_task(self.receive())

    async def receive(self):
        try:
            async for raw in self.ws:
                message = json.loads(raw)
                if "method" in message:
                    self.events[message["method"]] += 1
                    if "id" in message:
                        # Fail closed: this probe has no approval authority.
                        await self.ws.send(json.dumps({
                            "id": message["id"],
                            "error": {"code": -32601,
                                      "message": "Diagnostic cannot handle requests"},
                        }))
                elif message.get("id") in self.pending:
                    future = self.pending[message["id"]]
                    if not future.done():
                        future.set_result(message)
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ProbeError("Connection ended during request."))

    async def call(self, method, params):
        if method not in METHODS:
            raise ProbeError("Request is outside the diagnostic allowlist.")
        self.sequence += 1
        request_id = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        self.calls[method] += 1
        try:
            await self.ws.send(json.dumps({
                "id": request_id, "method": method, "params": params,
            }))
            result = await asyncio.wait_for(future, 15)
            if "error" in result:
                # Upstream error text can contain private paths and task content.
                raise ProbeError("Native request rejected; compatibility is unproven.")
            return result["result"]
        finally:
            self.pending.pop(request_id, None)

    async def initialize(self):
        await self.call("initialize", {
            "clientInfo": {"name": "native_continuity_probe", "version": "0.1.0"},
            "capabilities": {"experimentalApi": True},
        })
        await self.ws.send(json.dumps({"method": "initialized", "params": {}}))

    async def close(self):
        await self.ws.close()
        # Some native servers close the transport without a WebSocket close
        # frame. Pending RPC failures are already propagated by receive().
        await asyncio.gather(self.reader, return_exceptions=True)


async def require_loaded(client, thread_id):
    cursor = None
    seen = set()
    for _ in range(100):
        page = await client.call("thread/loaded/list", {"cursor": cursor, "limit": 100})
        if thread_id in page["data"]:
            return
        cursor = page.get("nextCursor")
        if cursor is None:
            break
        if cursor in seen:
            raise ProbeError("Invalid native pagination; refusing to resume.")
        seen.add(cursor)
    raise ProbeError("Thread is not confirmed loaded; refusing a cold resume.")


def identity(thread):
    if thread["status"]["type"] != "idle" or thread["ephemeral"]:
        raise ProbeError("This probe requires an idle, persistent thread.")
    return thread["id"], thread["sessionId"], thread["createdAt"]


async def probe(socket_path, thread_id):
    clients = []
    try:
        for _ in range(2):
            client = Client(await unix_connect(socket_path, open_timeout=10, max_size=4 * 1024 * 1024))
            clients.append(client)
            await client.initialize()
            await require_loaded(client, thread_id)
        first, second = clients
        initial = await first.call("thread/read", {"threadId": thread_id, "includeTurns": False})
        expected = identity(initial["thread"])
        # Loaded-state checks are a precondition, not an atomic attach guarantee.
        # Keep the original owner connected. Concurrent unload is still a risk.
        attached = await second.call("thread/resume", {"threadId": thread_id, "excludeTurns": True})
        if identity(attached["thread"]) != expected:
            raise ProbeError("Native identity changed across subscription.")
        await second.close()
        clients.pop()
        await require_loaded(first, thread_id)
        final = await first.call("thread/read", {"threadId": thread_id, "includeTurns": False})
        if identity(final["thread"]) != expected:
            raise ProbeError("Native identity changed after observer disconnect.")
        events = first.events + second.events
        if events["turn/started"] or events["thread/tokenUsage/updated"]:
            raise ProbeError("Task activity observed; the idle check is inconclusive.")
        return {
            "result": "pass",
            "scope": "idle_loaded_thread_metadata_only",
            "same_identity_at_sampled_checkpoints": True,
            "loaded_after_observer_disconnect": True,
            "turn_start_requests_sent": 0,
            "turn_start_events_observed": events["turn/started"],
            "token_usage_events_observed": events["thread/tokenUsage/updated"],
            "request_counts": dict(first.calls + second.calls),
        }
    finally:
        for client in reversed(clients):
            await client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, help="Private local app-server Unix socket")
    parser.add_argument("--thread", required=True, help="Existing, loaded thread UUID")
    args = parser.parse_args()
    try:
        thread_id = str(uuid.UUID(args.thread))
        result = asyncio.run(probe(private_socket(args.socket), thread_id))
    except ProbeError as error:
        print(json.dumps({"result": "not_passed", "reason": str(error)}))
        return 1
    except (Exception, KeyboardInterrupt):
        # Never echo raw server responses, account state, or private exception text.
        print(json.dumps({"result": "not_passed", "reason": "Interrupted, unavailable, or incompatible native interface."}))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
