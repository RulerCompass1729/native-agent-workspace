# Isolated DSH butler proof

This fixture boots the actual pinned DSH libraries in an owned process and talks
only to a local fixed-response model and a stdio MCP fixture. It is not a product
runner or a live-provider test. The root application dependencies are unchanged.

```sh
mkdir -p .local/dsh-deps
cp scripts/fixtures/dsh-proof/package.json scripts/fixtures/dsh-proof/package-lock.json .local/dsh-deps/
npm ci --prefix .local/dsh-deps --ignore-scripts --no-audit --no-fund
node scripts/test-butler-dsh-proof.cjs
```

The install downloads the pinned public npm dependency graph. The proof itself
requires macOS `sandbox-exec` and uses no real model or credential. The child has
an explicit synthetic environment, a private home under the lane's `.local`, and
an OS policy admitting only the model fixture's port. No daily application is
opened or modified. An owned Unix socket briefly uses `/tmp` because Unix socket
paths cannot fit the longer evidence path; closing its server removes it.

The host mounts nine explicit services/plugins: system prompt, LLM registry,
tool registry, sessions, agents, session projection, agent loop, DeepSeek API-key
provider, and MCP client. The `0.2.1-rc.2` provider uses Messages, unlike the older
CLI's chat-completions provider. `dsh-llm-deepseek` is the transport library;
`dsh-llm-deepseek-api-key` is the environment-key plugin. The code uses no default
CLI composition, account, telemetry, analytics, built-in tool, subagent or
compaction plugin. `dsh-brand` is an identity-preserving type-brand utility,
not a branding plugin. These dependencies remain pinned in the private prefix.

Only `mcp__native_workspace__workspace_status` is offered; it returns a constant.
The model fixture checks the actual tool list and `max_tokens=1024`. Request logs
retain header names, never auth, anonymous-user-id or session-id header values.
The upstream provider does send `user-agent`, `x-deepseek-harness-user-id` and
`x-deepseek-harness-session-id` to the fixture; their presence is not hidden by a
proxy or patched provider. The direct provider request goes to `/v1/messages`.

Three fresh DSH sessions consume three batches. The second has no first-session
history; before the third, the owned host is killed and restarted with the same
DSH home and reopened NAW ledger. Only `butler-policy.buildInput` supplies the
next model context. Session flush reports no DSH persistence plugin; continuity
comes from the NAW ledger. An unmodified controller is then tried with a DSH
record. At the recorded base, its role authorization requires `provider=codex`,
so this final integration case must remain BLOCKED and must invoke no model.
The proof never relabels DSH as Codex or changes a qualification flag.

Each request has unequal fixed usage counters. The host reads each DSH
`assistant/message` usage once, the test adapter uses the controller's
`run(input, expected)` envelope shape, and the NAW ledger retains it per batch/attempt.
That adapter is called directly because actual Controller role authorization blocks DSH.
This checks token attribution, not live-provider invoice accounting. The final
host receives an explicit close command: clean exit and no subsequent model
request are required. The earlier host is deliberately killed before restart.

A successful script exit means the measured behavior and the expected core
rejection were observed, not that all integration requirements passed. Inspect
`summary.json` (`partial-proof-core-role-blocked`), `requests.json`, the synthetic
session records and MCP receipts under `.local/evidence/b4-dsh-proof-20261110`.
The startup time measures process spawn to host-ready, including stdio MCP;
filesystem caches are not cleared. RSS samples cover only this short proof.
