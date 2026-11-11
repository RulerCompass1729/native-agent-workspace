# Butler native boundaries: tested configuration and remaining blockers

As of 2026-11-10. This is a configuration/negative-test checkpoint for Codex
**0.167.1**, not permission to activate the butler. In the final verification run,
ten real app-server turns received fifteen fixed responses from the local fixture; no model or paid API
was used. Two additional native sandbox commands exercised file/network policy.
The installed application, existing native sessions and user configuration were
not changed.

Run the executable experiment from the repository:

```sh
node scripts/test-butler-native-boundaries.cjs .local/evidence/butler-boundaries
```

It requires macOS, the exact native version and the existing loopback fixture.
It creates owned private configuration directories, copies no credentials and
removes provider/proxy environment variables before launching. Every model
request goes to its random loopback port. The existing OS policy positively
tests that other ports, external addresses, the resolver and keychain are
unreachable before the app-server starts. The two native sandbox commands run directly,
without that outer OS policy, so their denials measure Codex itself. Each case is bounded to three
local requests, RPCs to fifteen seconds and a turn to forty-five seconds.
Raw synthetic requests, native events, actual TOML and summaries go to the
requested private evidence directory. Owned native children and listeners exit.

## What actually worked

The `config()` function in the experiment is the executable configuration
source, including the synthetic provider. For the restricted cases it applies:

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek"
approval_policy = "never"
sandbox_mode = "read-only"
project_doc_max_bytes = 0
web_search = "disabled"
include_environment_context = false
include_environment_context_time = false
include_permissions_instructions = false
include_apps_instructions = false
include_collaboration_mode_instructions = false
analytics.enabled = false
feedback.enabled = false
check_for_update_on_startup = false

[tools.update_plan]
enabled = false
[tools.experimental_request_user_input]
enabled = false
[skills]
include_instructions = false

[features]
shell_tool = false
daemon_auto_start = false
view_image = false
multi_env_copy_file = false
apps = false
plugins = false
memories = false
js_repl = false
code_mode = false
code_mode_only = false
multi_agent = false
multi_agent_v2 = false
image_generation = false
request_permissions_tool = false
token_budget = false
current_time_reminder = false
sleep_tool = false
goals = false
tool_suggest = false
tool_search = false
shell_snapshot = false
```

These fields require a **fresh, controlled CODEX_HOME, HOME and working
directory**, no inherited MCP/plugin/model catalog, and trusted host-supplied
base/developer instructions. The test uses an explicit synthetic base prompt and
an empty developer override. Its provider endpoint is loopback with no real
authentication. Substituting a live endpoint is not authorized by this file.
Do not copy the person's existing configuration or credential files into the
new home.

With that complete setup, the captured request had `tools: []`. Five separate
fixed responses then attempted `exec_command`, `apply_patch`, `view_image`,
`web.run` and a synthetic MCP function. Codex returned an unsupported/unknown
tool result for each; no forbidden file was written. This tests dispatch,
not just whether the tool was displayed. The fresh restricted home had no global instruction file to inherit; its global
sentinel was therefore absent. A positive control with project bytes enabled
sent the project marker; the zero-byte cases did not. The inherited-global
counterexample below deliberately supplies that file and observes its content.

This is evidence for the exact tested native version and model-metadata
conditions. It is **not an immutable tool ceiling**.

## Counterexamples that must remain visible

| Proposed shortcut | Native observation | Consequence |
| --- | --- | --- |
| Only `shell_tool=false`, project documents disabled | Nine other tools remained, including image access, multi-agent and goal tools; the synthetic global AGENTS content entered the request. | Not sufficient. |
| All listed features disabled, but an existing CODEX_HOME contains AGENTS | Tool list stayed empty; the global instruction sentinel still entered the request. | Project-byte and skill flags do not isolate global instructions. |
| All listed features disabled, but a model catalog supplies patch capability | `apply_patch` reappeared in the request. | Model metadata is part of the boundary; feature switches alone are not a complete registry ceiling. |
| `read-only` sandbox means files are private | The native sandbox command read the synthetic file outside its working directory. | Read-only prevents writes, not arbitrary reads. |

The last row was tested with `codex sandbox -P :read-only`, not inferred from
the model's reply. A named native permission profile did deny the same file and
outbound TCP:

```toml
[permissions.boundary]
extends = ":read-only"
[permissions.boundary.filesystem]
"/absolute/path/to/synthetic-outside-file" = "deny"
[permissions.boundary.network]
enabled = false
```

`codex sandbox -P boundary -- ...` returned a file permission error and
network EPERM, with no file contents. The actual fixture substitutes its own
absolute sentinel path. Both the read-only and named-profile runs blocked
external TCP. This is a scoped command-sandbox result; it does not prove that
the parent app-server's automatic instruction loading or provider HTTP
transport uses that sandbox. Nested macOS sandbox application was unavailable
in the initial app-server-command probe, so that failed attempt is not counted
as file isolation evidence.

## Source explanation and unresolved integration

The inspected official source is pinned at
[086ccc8 / rust-v0.167.0](https://github.com/openai/codex/tree/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a).
It explains the mechanisms; the executed 0.167.1 binary supplies the runtime
evidence. These are distinct versions, not assumed equivalent:

- [Tool construction](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/src/tools/spec_plan.rs):
  shell tools and patch registration have separate conditions. The
  `multi_agent_v2.disable_native_tools` setting only controls collaboration
  tools. The obsolete `apply_patch_freeform` feature is not a patch-off switch.
- [Startup ToolPolicy](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/ext/extension-api/src/tool_policy.rs):
  an empty allowed-tools list is a real construction ceiling, supplied by a
  Rust host extension before thread startup. No equivalent ordinary app-server
  configuration/RPC field was established here. Do not invent one.
- [Project instruction loading](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/src/agents_md.rs)
  and the separate
  [global instruction provider](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/codex-home/src/instructions/mod.rs)
  explain why zero project bytes do not suppress the global file.
- [Native permission profiles](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/config/src/permissions_toml.rs)
  distinguish filesystem and network policy from tool registration.

**B4 activation remains blocked**, with these concrete next steps:

1. The B4 runner owner must adopt a separate controlled native home/config and
   fixed instruction/context sources. The earlier dedicated-service binding
   checkpoint alone still uses the existing named profile; it is not this
   privacy boundary.
2. The runner owner must enforce and verify the permitted model metadata and
   tool registry on every relevant startup/recovery/model change, or use a
   supported host interface for the immutable ToolPolicy. A successful empty
   tool request in one fixture cannot certify arbitrary inherited catalogs,
   plugins, new native versions or future tool registrations.
3. The live provider process needs a verified outbound policy that admits only
   its approved inference destination, plus file/context isolation at the
   correct process boundary. The loopback OS policy is deliberately local-only
   and is not a tested live DeepSeek allowlist.

The security qualification flags remain false. These are technical integration
blockers owned by the B4 runner/core work, not a request for the person to waive
privacy. Official pricing research can proceed independently. Live provider
testing still requires the person's separate finite-trial approval and the
unresolved boundary gates; neither has been replaced by these synthetic runs.
