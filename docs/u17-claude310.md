# U17 Claude 2.1.310 对照（Claude lane 提交，待 Codex 合并）

As of 2026-10-24。本文件是 [interaction](interaction.md) 中 U17 验收表的 Claude 310 部分，
由 Claude lane 提供；并入方式由 Codex 决定。**U17 未完成。**

问题：Claude 310 的 GUI 与原生 TUI 缺口没有完整清单。
现有机制：`app/adapters.cjs` 的 Claude 启动参数、`app/claude-bridge/hooks/register.js` 订阅的原生事件、同屏 xterm。
最小增量：按官方来源逐项列出，标明 GUI 原样或同屏原生 TUI，并单列 NAW 启动方式造成的差异。
不做会坏什么：被 NAW 启动参数关闭的原生功能会被误记成原生本身没有。

来源：Claude Code 闭源。来源只用官方文档（[llms.txt](https://code.claude.com/docs/llms.txt)）、
Claude Code 2.1.310 为 mod 写出的类型声明和本机 CLI 输出；没有拆安装包。文档会更新，
表中“命令:N”“键位:N”的行号对应清单里记录 SHA-256 的存档版本，链接指向当前页面。
源标识索引见 [`claude310-inventory.json`](../scripts/fixtures/claude310-inventory.json)：
121 个命令条目（119 个不同命令名，3 个文档注明已移除）、27 个键位上下文、
147 个键位条目（139 个不同动作；25 个的上下文由文档逐句说明，3 个文档未写）、
70 个界面章节、6 种权限模式、33 个 hook 事件、36 种 SDK 消息和 111 个引擎接口名。
hook、SDK 与引擎项包含非交互界面，数量不等于用户功能数，也不代表已经支持。

发现证据 `CL-INV-01`：隔离 `HOME` 与 `CLAUDE_CONFIG_DIR`，运行未修改的 Claude 2.1.310，
启动参数与环境变量按 NAW，但有以下差异：加了 `--model haiku` 和
`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`（探测脚本本身由 Claude Code 启动，避免被判为嵌套会话）；
没有 NAW 的 `--mcp-config`、`--allowedTools` 和设置里的 hook。全新配置等于“首次会话”，
也没有不设 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 的对照运行。
本地服务拒绝所有请求，实际收到 0 次请求。只在原生 API key 确认框按过一次 Enter，
任何命令都没有按 Enter。逐个输入 119 个命令名：88 个在菜单中列出；31 个未列出，
其中 3 个文档注明已移除，7 个按文档受 CL-X02 影响（探测无法单独证明原因），
2 个依赖上下文，19 个需要 claude.ai 订阅、`gh` 登录、云会话或 Chrome，用 API key fixture 无法区分。
这是菜单发现，不是执行验收。键位只有来源，尚无运行证据。逐项画面留在私有验证目录。

发现证据 `CL-INV-02`：同样的隔离环境与启动方式，加了只记录 SessionStart/SessionEnd 的 hook。
1 次本地固定回复，零付费。`/branch`：进程不变，原生会话 ID 变化，事件为 SessionEnd `resume`
→ SessionStart `fork`。`/resume`：选择器可打开、Esc 取消。`/background`：内嵌终端里的进程退出
（SessionEnd `prompt_input_exit`），原生守护进程与 `bg-pty-host` 进程继续运行，hook 与屏幕显示新的会话 ID
（SessionStart `fork`，屏幕提示 `claude agents` / `claude attach`）。NAW 当前只跟随 clear，
终端退出即记为结束；两项的 GUI 表现是按源码推断，未在 GUI 里实测。探测结束时向本探测启动的后台进程发了 SIGTERM，
1.5 秒后仍有 2 个 `bg-pty-host` 在运行，复核时已退出。

需要用户决定：CL-X02（关闭遥测连带关闭的原生功能）和 CL-X03（原生自行发起的后台模型请求）。
CL-X07（预先放行 NAW 定向消息工具）影响真人控制，需在验收中写明。

| ID／功能 | 官方来源／条件 | GUI 或同屏原生 TUI；原因／当前缺口 | 证据与状态 |
| --- | --- | --- | --- |
| CL-I01 文字输入、换行、光标与单词编辑、撤销 | `interactive-mode#text-editing; keybindings chat:*` | GUI 基本输入；原生专用编辑在同屏原生 TUI 里用，保留原生键位 | **待验** |
| CL-I02 粘贴与大段粘贴占位 `[Pasted text #N]` | `terminal-config#how-claude-treats-pasted-text` | 在同屏原生 TUI 里用；**“按粘贴而非打字处理”需要 feature flag，NAW 启动时不可用（CL-X02）** | **待验** |
| CL-I03 输入历史、Ctrl+R 反向搜索、找回清除的草稿、Vim 模式 | `interactive-mode#command-history; #vim-editor-mode` | 在同屏原生 TUI 里用；不另做历史或编辑器 | **待验** |
| CL-I04 运行中排队消息、取回排队、`/btw` 旁问 | `interactive-mode#queue-messages-while-claude-works; #side-questions-with-btw` | GUI 发送走原生 `prompt.submit`；排队编辑与旁问在同屏原生 TUI 里用 | **待验** |
| CL-I05 `/` 命令补全、技能串联、`@` 文件提及、MCP prompts | `commands#how-the-command-menu-matches-what-you-type` | 在同屏原生 TUI 里用；保留原生补全与上下文绑定 | **待验** |
| CL-I06 图片粘贴与附件 | `keybindings#attachments-actions` | 在同屏原生 TUI 里用；**内嵌终端能否传入剪贴板图片待实测** | **待验** |
| CL-I07 `!` shell 模式与后台 Bash | `interactive-mode#shell-mode-with--prefix; #background-bash-commands` | 在同屏原生 TUI 里用；不另起 shell 生命周期 | **待验** |
| CL-I08 提示建议（灰字示例与下一步建议） | `interactive-mode#prompt-suggestions` | **NAW 意图关闭**：每条建议是一次后台模型请求，与“无隐藏模型调用”冲突；但所传参数的交互模式效果未核（CL-X01） | **待验** |
| CL-I09 拼写检查、emoji 短码、不可见字符提示 | `interactive-mode#check-spelling-as-you-type; #emoji-shortcodes` | 在同屏原生 TUI 里用 | **待验** |
| CL-I10 语音输入 | `interactive-mode#voice-input` | 在同屏原生 TUI 里用；物理麦克风需实测 | **待验** |
| CL-R01 助手正文流式显示、Markdown、链接 | `hooks#messagedisplay; engine ui.render` | GUI 原文（`classic.MessageDisplay` 的可见内容）；原生排版在同屏原生 TUI 里用 | **待验** |
| CL-R02 思考、请求/流式阶段、spinner、计时与 token | `engine turn.step` | GUI 只显示原生阶段种类（requesting/thinking/text/input/tool）；原生 spinner 文字与计时在同屏原生 TUI 里用，不翻译 | **待验** |
| CL-R03 工具调用、输入、结果、失败 | `engine tool.call; session.append` | GUI 原生工具名、输入 JSON 与文本结果；非文本结果只标未完整，原样在同屏原生 TUI 里用 | **待验** |
| CL-R04 文件 diff、`/diff` 面板与 diff 对话框 | `interactive-mode#review-changes-with-diff` | 在同屏原生 TUI 里用 | **待验** |
| CL-R05 任务清单（Ctrl+T to-do） | `interactive-mode#task-list` | 在同屏原生 TUI 里用；GUI 只见对应工具调用，不重画清单 | **待验** |
| CL-R06 子 agent、Agent Teams、后台任务与 `/tasks` | `sub-agents; agent-teams; agent-view` | 在同屏原生 TUI 里用；GUI 过滤 `agentId` 事件，不把子 agent 当根会话 | **待验** |
| CL-R07 完成时间、耗时与回合页脚 | `engine turn.complete` | GUI 只显示原生回合边界与状态；完整页脚在同屏原生 TUI 里用，不重建时钟 | **待验** |
| CL-R08 Session recap 与 `/recap` | `interactive-mode#session-recap` | 在同屏原生 TUI 里用；**自动 recap 默认开启且是后台模型请求（CL-X03）** | **待验** |
| CL-R09 用量、上下文、额度等待与自动继续 | `interactive-mode#wait-for-a-usage-limit-to-reset; costs` | GUI 只显示 `session.usage()` 范围；完整状态与等待在同屏原生 TUI 里用 | **待验** |
| CL-R10 状态行（statusline） | `statusline` | 在同屏原生 TUI 里用；按用户自己的 statusline 设置 | **待验** |
| CL-R11 PR/MR 状态徽标 | `interactive-mode#pr-review-status` | **NAW 启动时关闭**：同一变量关闭 PR/MR 状态检查（CL-X02） | **待验** |
| CL-R12 全屏渲染、鼠标、滚动与选择 | `fullscreen` | 在同屏原生 TUI 里用；**内嵌 xterm 的鼠标与 alt-screen 行为待实测** | **待验** |
| CL-A01 工具权限请求与决定 | `permission-modes; hooks#permissionrequest` | GUI 原样显示请求（工具名与输入）；决定在同屏原生 TUI 里做，NAW 不代答 | **待验** |
| CL-A02 AskUserQuestion 问题、选项与自由回答 | `engine ui.render AskUserQuestion` | GUI 原样显示问题与选项；作答与取消在同屏原生 TUI 里用 | **待验** |
| CL-A03 Plan 模式与退出 Plan 的确认 | `permission-modes#analyze-before-you-edit-with-plan-mode` | 在同屏原生 TUI 里用；GUI 只见对应权限请求 | **待验** |
| CL-A04 MCP elicitation 表单与密钥 | `hooks#elicitation` | 在同屏原生 TUI 里用；不导出表单或密钥 | **待验** |
| CL-A05 权限模式与切换（Shift+Tab 等） | `permission-modes; auto-mode-classifier-billing` | 在同屏原生 TUI 里用；NAW 当前不传 `--permission-mode`，原生默认为 auto（探测启动横幅可见）；分类器请求见 CL-X03 | **待验** |
| CL-S01 新建、恢复、分支、fork、teleport 与根会话身份 | `sessions; commands` | GUI 跟随原生 clear；**`/branch` 与 `/background` 已实测会换原生会话 ID（CL-INV-02）；按源码 NAW 不跟随，GUI 实测待验**；resume/teleport/tui 待验 | **待验** |
| CL-S02 模型、effort、fast mode、output style | `model-config; fast-mode; output-styles` | GUI 只跟随模型名；选择器在同屏原生 TUI 里用；**fast mode 可用性检查被 CL-X02 关闭，影响待验** | **待验** |
| CL-S03 配置、记忆、技能、hooks、插件、主题、快捷键设置 | `commands; settings-reference` | 在同屏原生 TUI 里用；**云端同步的技能与插件因 CL-X02 不加载** | **待验** |
| CL-S04 检查点与 `/rewind` | `checkpointing` | 在同屏原生 TUI 里用；**回退对 GUI 已显示记录的影响待验** | **待验** |
| CL-S05 上下文压缩（手动、自动、空闲压缩） | `hooks#precompact; settings-reference#idlecompaction` | 在同屏原生 TUI 里用；**空闲压缩需要 feature flag，NAW 启动时不可用（CL-X02）** | **待验** |
| CL-S06 错误、重试、重新登录与恢复 | `errors` | GUI 原样显示原生 API 错误正文与失败边界；恢复操作在同屏原生 TUI 里用 | **待验** |
| CL-S07 通知、终端标题、无障碍 | `terminal-config` | 在同屏原生 TUI 里用；**内嵌 xterm 是否转发系统通知与标题待实测** | **待验** |
| CL-X01 `--prompt-suggestions false` | `app/adapters.cjs Claude 启动参数; cli-reference; interactive-mode#turn-prompt-suggestions-off` | 意图关闭后台建议请求。**文档只把该参数写在 `--print` 输出模式下**，交互模式的关闭方式是 `/config`、`promptSuggestionEnabled` 或 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`；文档另称不获取 feature flag 时交互模式默认不显示建议（与 CL-X02 相关）。参数在交互模式的实际效果待验 | **待验** |
| CL-X02 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | `env-vars#features-that-need-feature-flag-fetching; env-vars CLAUDE_CODE_ARTIFACT_COMMENTS` | **需用户决定**：按官方文档，该变量关闭遥测、`/feedback`、release notes、PR 徽标与 artifacts，并关闭 feature flag 获取，约 15 项原生功能不可用（Remote Control、`/import`、`/skill-doctor`、advisor、云端技能同步、长粘贴识别、空闲压缩等）。菜单探测：`/advisor`、`/import`、`/skill-doctor`、`/remote-control`、`/artifacts`、`/artifact-capabilities`、`/artifact-diagramming` 未列出，但探测是首次会话且无对照，不能单独证明原因；`/feedback`、`/release-notes` 仍列出，执行结果待验。不设此变量的普通 claude 没有这些差异 | **待验** |
| CL-X03 原生自行发起的后台模型请求 | `interactive-mode#session-recap; settings-reference#awaysummaryenabled; permission-modes; auto-mode-classifier-billing` | **需用户决定统一口径**：自动 session recap 默认开启（会话满 3 轮、上一轮结束 3 分钟且终端失焦后发一次后台请求）；auto 是原生默认权限模式，默认在会话自身的模型请求中检查操作，服务端检查不可用时原生会另发分类器请求。两者都是原生行为、NAW 未改，与 CL-X01 关闭建议请求的理由不一致 | **待验** |
| CL-X04 Agent Teams 打开且 `teammateMode: in-process` | `env-vars CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS; settings-reference#teammatemode` | 有意设置：在同一终端内显示队友，不拆 tmux 窗格 | **待验** |
| CL-X05 附加 MCP 服务 `native_workspace` 与插件目录 | `app/adapters.cjs Claude 启动参数` | 有意添加：`/mcp` 与工具列表多出 NAW 的定向消息工具 | **待验** |
| CL-X06 `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` | `env-vars` | 有意设置：不自动安装官方插件市场 | **待验** |
| CL-X07 `--allowedTools mcp__native_workspace__workspace_message` | `app/adapters.cjs Claude 启动参数; register.js tool.call` | 有意设置：预先允许 NAW 的定向消息工具，原生不再为它弹权限确认；是否放行改由 NAW 自己的协作授权检查决定。**影响真人控制，需在验收中写明** | **待验** |
| CL-X08 设置文件加入 14 个 command hook | `app/adapters.cjs Claude 启动参数; app/claude_hook.py` | 有意设置：只做本地观察、不回答原生审批，每个 hook 限时 2 秒；`/hooks` 会列出这些 hook | **待验** |
| CL-CMD001 `/add-dir <path>` | [命令:52](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD002 `/advisor [model\|off]` | [命令:53](https://code.claude.com/docs/en/commands) | **按文档在 NAW 启动环境下不可用**：advisor 需要 feature flag（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；**待用户决定 CL-X02** |
| CL-CMD003 `/agents` | [命令:54](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；2.1.310 菜单标为 (removed)，只打印提醒 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD004 `/artifact-capabilities` | [命令:55](https://code.claude.com/docs/en/commands)；内置技能 | **按文档在 NAW 启动环境下不可用**（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；**待用户决定 CL-X02** |
| CL-CMD005 `/artifact-diagramming` | [命令:56](https://code.claude.com/docs/en/commands)；内置技能 | **按文档在 NAW 启动环境下不可用**（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；**待用户决定 CL-X02** |
| CL-CMD006 `/artifacts` | [命令:57](https://code.claude.com/docs/en/commands) | **按文档在 NAW 启动环境下不可用**（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；**待用户决定 CL-X02** |
| CL-CMD007 `/auto-mode-setup` | [命令:58](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD008 `/autocompact [auto\|<tokens>]` | [命令:59](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD009 `/autofix-pr [prompt]` | [命令:60](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD010 `/background [prompt]` | [命令:61](https://code.claude.com/docs/en/commands)；别名 `/bg` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；**缺口（CL-INV-02）**：内嵌终端里的原生进程退出（SessionEnd `prompt_input_exit`），原生守护进程继续运行，hook 显示新会话 ID（SessionStart `fork`）；按源码，NAW 会按终端退出把会话记为结束、看不到后台会话，GUI 实测待验 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD011 `/batch <instruction>` | [命令:62](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD012 `/branch [name]` | [命令:63](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；**缺口（CL-INV-02）**：同一进程换到新会话 ID（SessionEnd `resume` → SessionStart `fork`）；NAW 只跟随 clear，按源码会停止跟随并关闭 GUI 输入，GUI 实测待验 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD013 `/btw [question]` | [命令:64](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD014 `/bug [report]` | [命令:65](https://code.claude.com/docs/en/commands)；别名 `/share` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD015 `/cd <path>` | [命令:66](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD016 `/chrome` | [命令:67](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD017 `/claude-api [migrate\|upgrade\|api-version\|managed-agents-onboard\|managed-agents-secure\|prompt-audit\|cost-optimize\|build-eval\|hillclimb\|preserved-thinking-migration]` | [命令:68](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD018 `/claude-in-chrome [task]` | [命令:69](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；只在本会话开启 Chrome 集成时出现；**待条件下验收** |
| CL-CMD019 `/clear [name]` | [命令:70](https://code.claude.com/docs/en/commands)；别名 `/reset`、`/new` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 跟随原生清空后的新根会话（`register.js` session.end + SessionStart clear） | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD020 `/code-review [low\|medium\|high\|xhigh\|max\|ultra] [--fix] [--comment] [--max-findings n\|all\|default] [pr#\|branch\|path]` | [命令:71](https://code.claude.com/docs/en/commands)；内置技能；别名 `/review` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD021 `/color [color\|default]` | [命令:72](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD022 `/compact [instructions]` | [命令:73](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD023 `/config [key=value ...]` | [命令:74](https://code.claude.com/docs/en/commands)；别名 `/settings` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD024 `/context [all]` | [命令:75](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD025 `/copy [N]` | [命令:76](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；经内嵌终端写系统剪贴板，**待实测** | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD026 `/cost` | [命令:77](https://code.claude.com/docs/en/commands)；`/usage` 的别名 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 只显示原生 `session.usage()` 的范围用量 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD027 `/dataviz [request]` | [命令:78](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD028 `/debug [description]` | [命令:79](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD029 `/deep-research <question>` | [命令:80](https://code.claude.com/docs/en/commands)；内置工作流 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD030 `/design [brief]` | [命令:81](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD031 `/design consent` | [命令:82](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD032 `/design revoke` | [命令:82](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD033 `/design-login` | [命令:83](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD034 `/design-sync [hint]` | [命令:84](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD035 `/desktop` | [命令:85](https://code.claude.com/docs/en/commands)；别名 `/app` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD036 `/diff` | [命令:86](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD037 `/doctor [prompt-audit [path]]` | [命令:87](https://code.claude.com/docs/en/commands)；内置技能；别名 `/checkup` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD038 `/effort [level\|auto\|status\|ultracode [on\|off]]` | [命令:88](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD039 `/exit` | [命令:89](https://code.claude.com/docs/en/commands)；别名 `/quit` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 只跟随原生退出状态 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD040 `/export [filename]` | [命令:90](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD041 `/fast [on\|off]` | [命令:91](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD042 `/feedback [report]` | [命令:92](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；文档称 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 关闭 `/feedback`，菜单仍列出，**执行结果待验**（CL-X02） | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD043 `/fewer-permission-prompts` | [命令:93](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD044 `/focus` | [命令:94](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD045 `/fork [prompt]` | [命令:95](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；复制到新的后台会话，**该会话在 GUI 中如何出现待验** | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD046 `/goal [condition\|clear]` | [命令:96](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD047 `/heapdump` | [命令:97](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD048 `/help` | [命令:98](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD049 `/hooks` | [命令:99](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD050 `/ide` | [命令:100](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD051 `/import [codex\|gemini\|cursor] [--dry-run] [--yes]` | [命令:101](https://code.claude.com/docs/en/commands) | **按文档在 NAW 启动环境下不可用**：需要 feature flag（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；**待用户决定 CL-X02** |
| CL-CMD052 `/init` | [命令:102](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD053 `/insights` | [命令:103](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD054 `/install-github-app` | [命令:104](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD055 `/install-slack-app` | [命令:105](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD056 `/keybindings` | [命令:106](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD057 `/list-agents` | [命令:107](https://code.claude.com/docs/en/commands)；别名 `/peers` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD058 `/login` | [命令:108](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD059 `/logout` | [命令:109](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD060 `/loop [interval] [prompt]` | [命令:110](https://code.claude.com/docs/en/commands)；内置技能；别名 `/proactive` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD061 `/mcp [reconnect (<server>\|all)\|enable\|disable [<server>\|all]]` | [命令:111](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD062 `/memory` | [命令:112](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD063 `/mobile` | [命令:113](https://code.claude.com/docs/en/commands)；别名 `/ios`、`/android` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD064 `/model [model]` | [命令:114](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 标题跟随原生 `PostModelSwitch` 的 `to_model` | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD065 `/output-style [style]` | [命令:115](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD066 `/passes` | [命令:116](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD067 `/permissions` | [命令:117](https://code.claude.com/docs/en/commands)；别名 `/allowed-tools` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD068 `/plan [description]` | [命令:118](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD069 `/plugin [subcommand]` | [命令:119](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD070 `/plugin-authoring` | [命令:120](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD071 `/powerup` | [命令:121](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD072 `/pr-comments [PR]` | [命令:122](https://code.claude.com/docs/en/commands) | 原生已移除（文档注明），无需映射 | INV：菜单未列出；原生已移除 |
| CL-CMD073 `/privacy-settings` | [命令:123](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD074 `/radio` | [命令:124](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD075 `/rate-limit-options` | [命令:125](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD076 `/recap` | [命令:126](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；原生自己生成，GUI 不另调模型 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD077 `/release-notes` | [命令:127](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；文档称同一变量关闭 release notes，菜单仍列出，**执行结果待验**（CL-X02） | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD078 `/reload-plugins [--force]` | [命令:128](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD079 `/reload-skills` | [命令:129](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD080 `/remote-control` | [命令:130](https://code.claude.com/docs/en/commands)；别名 `/rc` | **按文档在 NAW 启动环境下不可用**：Remote Control 需要 feature flag（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；**待用户决定 CL-X02** |
| CL-CMD081 `/remote-env` | [命令:131](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD082 `/rename [name]` | [命令:132](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD083 `/resume [session]` | [命令:133](https://code.claude.com/docs/en/commands)；别名 `/continue` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；会在同一终端换到另一会话；选择器已实测可打开与取消，换会话后 GUI 是否跟随待验（现只跟随 clear） | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD084 `/review [low\|medium\|high\|xhigh\|max\|ultra] [--fix] [--comment] [--max-findings n\|all\|default] [pr#\|branch\|path]` | [命令:134](https://code.claude.com/docs/en/commands)；`/code-review` 的别名 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD085 `/rewind` | [命令:135](https://code.claude.com/docs/en/commands)；别名 `/checkpoint`、`/undo` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD086 `/run` | [命令:136](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD087 `/run-skill-generator` | [命令:137](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD088 `/sandbox` | [命令:138](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD089 `/schedule [description]` | [命令:139](https://code.claude.com/docs/en/commands)；别名 `/routines` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD090 `/scroll-speed` | [命令:140](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD091 `/security-review` | [命令:141](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD092 `/setup-bedrock` | [命令:142](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD093 `/setup-vertex` | [命令:143](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD094 `/simplify [target]` | [命令:144](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD095 `/skill-doctor` | [命令:145](https://code.claude.com/docs/en/commands) | **按文档在 NAW 启动环境下不可用**：需要 feature flag（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；**待用户决定 CL-X02** |
| CL-CMD096 `/skills` | [命令:146](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD097 `/slides [brief]` | [命令:147](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD098 `/stats` | [命令:148](https://code.claude.com/docs/en/commands)；`/usage` 的别名 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 只显示原生 `session.usage()` 的范围用量 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD099 `/status` | [命令:149](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD100 `/statusline` | [命令:150](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD101 `/stickers` | [命令:151](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD102 `/stop` | [命令:152](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；只在已附着后台会话时出现；**待条件下验收** |
| CL-CMD103 `/subtask <task>` | [命令:153](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD104 `/tasks` | [命令:154](https://code.claude.com/docs/en/commands)；别名 `/bashes` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD105 `/team-onboarding` | [命令:155](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD106 `/teleport` | [命令:156](https://code.claude.com/docs/en/commands)；别名 `/tp` | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；**把云端会话拉进本终端，GUI 根会话是否跟随待验** | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD107 `/terminal-setup` | [命令:157](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD108 `/theme` | [命令:158](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD109 `/tui [default\|fullscreen]` | [命令:159](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；**会以新渲染器重启原生进程，GUI 是否保持同一原生身份待验** | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD110 `/ultraplan <prompt>` | [命令:160](https://code.claude.com/docs/en/commands) | 原生已移除（文档注明），无需映射 | INV：菜单未列出；原生已移除 |
| CL-CMD111 `/ultrareview [PR or branch]` | [命令:161](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD112 `/update-config [request]` | [命令:162](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD113 `/upgrade` | [命令:163](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD114 `/usage` | [命令:164](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 只显示原生 `session.usage()` 的范围用量 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD115 `/usage-credits` | [命令:165](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD116 `/verify` | [命令:166](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD117 `/vim` | [命令:167](https://code.claude.com/docs/en/commands) | 原生已移除（文档注明），无需映射 | INV：菜单未列出；原生已移除 |
| CL-CMD118 `/voice [hold\|tap\|off]` | [命令:168](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置；麦克风由原生进程直接取用，物理设备需实测 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD119 `/web-setup` | [命令:169](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD120 `/workflow-authoring` | [命令:170](https://code.claude.com/docs/en/commands)；内置技能 | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-CMD121 `/workflows` | [命令:171](https://code.claude.com/docs/en/commands) | 在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；**待执行验收** |
| CL-KEY001 `app:interrupt` | [键位:89](https://code.claude.com/docs/en/keybindings)；Global；默认 Ctrl+C | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器；GUI 中断另走原生 `turn.abort` | 来源已列；**待实际键位行为验收** |
| CL-KEY002 `app:exit` | [键位:90](https://code.claude.com/docs/en/keybindings)；Global；默认 Ctrl+D | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY003 `app:redraw` | [键位:91](https://code.claude.com/docs/en/keybindings)；Global；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY004 `app:toggleTodos` | [键位:92](https://code.claude.com/docs/en/keybindings)；Global；默认 Ctrl+T | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY005 `app:toggleTranscript` | [键位:93](https://code.claude.com/docs/en/keybindings)；Global；默认 Ctrl+O | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY006 `history:search` | [键位:101](https://code.claude.com/docs/en/keybindings)；文档未写上下文；默认 Ctrl+R | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY007 `history:previous` | [键位:102](https://code.claude.com/docs/en/keybindings)；文档未写上下文；默认 Up | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY008 `history:next` | [键位:103](https://code.claude.com/docs/en/keybindings)；文档未写上下文；默认 Down | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY009 `chat:cancel` | [键位:111](https://code.claude.com/docs/en/keybindings)；Chat；默认 Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY010 `chat:clearInput` | [键位:112](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+L | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY011 `chat:clearScreen` | [键位:113](https://code.claude.com/docs/en/keybindings)；Chat；默认 Cmd+K | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY012 `chat:killAgents` | [键位:114](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+X Ctrl+K | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY013 `chat:cycleMode` | [键位:115](https://code.claude.com/docs/en/keybindings)；Chat；默认 Shift+Tab\* | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY014 `chat:modelPicker` | [键位:116](https://code.claude.com/docs/en/keybindings)；Chat；默认 Meta+P | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY015 `chat:fastMode` | [键位:117](https://code.claude.com/docs/en/keybindings)；Chat；默认 Meta+O | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY016 `chat:thinkingToggle` | [键位:118](https://code.claude.com/docs/en/keybindings)；Chat；默认 Meta+T | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY017 `chat:submit` | [键位:119](https://code.claude.com/docs/en/keybindings)；Chat；默认 Enter | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY018 `chat:queueSubmit` | [键位:120](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+X Enter | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY019 `chat:sendNow` | [键位:121](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+Enter, Ctrl+X Ctrl+S | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY020 `chat:newline` | [键位:122](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+J | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY021 `chat:undo` | [键位:123](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+\_, Ctrl+Shift+- | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY022 `chat:externalEditor` | [键位:124](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+G, Ctrl+X Ctrl+E | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY023 `chat:stash` | [键位:125](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+S | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY024 `chat:imagePaste` | [键位:126](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+V (Alt+V on Windows and WSL) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY025 `command:<name>` | [键位:127](https://code.claude.com/docs/en/keybindings)；Chat；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY026 `autocomplete:accept` | [键位:137](https://code.claude.com/docs/en/keybindings)；Autocomplete；默认 Tab | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY027 `autocomplete:dismiss` | [键位:138](https://code.claude.com/docs/en/keybindings)；Autocomplete；默认 Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY028 `autocomplete:previous` | [键位:139](https://code.claude.com/docs/en/keybindings)；Autocomplete；默认 Up | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY029 `autocomplete:next` | [键位:140](https://code.claude.com/docs/en/keybindings)；Autocomplete；默认 Down | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY030 `confirm:yes` | [键位:148](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Enter | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY031 `confirm:no` | [键位:149](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY032 `confirm:previous` | [键位:150](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Up | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY033 `confirm:next` | [键位:151](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Down | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY034 `confirm:nextField` | [键位:152](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Tab | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY035 `confirm:previousField` | [键位:153](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY036 `confirm:toggle` | [键位:154](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Space | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY037 `confirm:cycleMode` | [键位:155](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Shift+Tab\* | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY038 `permission:toggleDebug` | [键位:191](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY039 `transcript:toggleShowAll` | [键位:199](https://code.claude.com/docs/en/keybindings)；Transcript；默认 Ctrl+E | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY040 `transcript:exit` | [键位:200](https://code.claude.com/docs/en/keybindings)；Transcript；默认 q, Ctrl+C, Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY041 `historySearch:next` | [键位:210](https://code.claude.com/docs/en/keybindings)；HistorySearch；默认 Ctrl+R | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY042 `historySearch:accept` | [键位:211](https://code.claude.com/docs/en/keybindings)；HistorySearch；默认 Escape, Tab | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY043 `historySearch:cancel` | [键位:212](https://code.claude.com/docs/en/keybindings)；HistorySearch；默认 Ctrl+C | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY044 `historySearch:execute` | [键位:213](https://code.claude.com/docs/en/keybindings)；HistorySearch；默认 Enter | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY045 `historySearch:cycleScope` | [键位:214](https://code.claude.com/docs/en/keybindings)；HistorySearch；默认 Ctrl+S | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY046 `task:background` | [键位:224](https://code.claude.com/docs/en/keybindings)；Task；默认 Ctrl+B, Ctrl+X Ctrl+B | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY047 `theme:toggleSyntaxHighlighting` | [键位:232](https://code.claude.com/docs/en/keybindings)；ThemePicker；默认 Ctrl+T | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY048 `help:dismiss` | [键位:240](https://code.claude.com/docs/en/keybindings)；Help；默认 Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY049 `tabs:next` | [键位:248](https://code.claude.com/docs/en/keybindings)；Tabs；默认 Tab, Right | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY050 `tabs:previous` | [键位:249](https://code.claude.com/docs/en/keybindings)；Tabs；默认 Shift+Tab, Left | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY051 `attachments:next` | [键位:261](https://code.claude.com/docs/en/keybindings)；Attachments；默认 Right | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY052 `attachments:previous` | [键位:262](https://code.claude.com/docs/en/keybindings)；Attachments；默认 Left | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY053 `attachments:remove` | [键位:263](https://code.claude.com/docs/en/keybindings)；Attachments；默认 Backspace, Delete | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY054 `attachments:exit` | [键位:264](https://code.claude.com/docs/en/keybindings)；Attachments；默认 Down, Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY055 `footer:next` | [键位:272](https://code.claude.com/docs/en/keybindings)；Footer；默认 Right | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY056 `footer:previous` | [键位:273](https://code.claude.com/docs/en/keybindings)；Footer；默认 Left | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY057 `footer:up` | [键位:274](https://code.claude.com/docs/en/keybindings)；Footer；默认 Up, Ctrl+P | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY058 `footer:down` | [键位:275](https://code.claude.com/docs/en/keybindings)；Footer；默认 Down, Ctrl+N | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY059 `footer:openSelected` | [键位:276](https://code.claude.com/docs/en/keybindings)；Footer；默认 Enter | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY060 `footer:clearSelection` | [键位:277](https://code.claude.com/docs/en/keybindings)；Footer；默认 Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY061 `footer:close` | [键位:278](https://code.claude.com/docs/en/keybindings)；Footer；默认 x | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY062 `footer:dismiss` | [键位:279](https://code.claude.com/docs/en/keybindings)；Footer；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY063 `diff:dismiss` | [键位:314](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY064 `diff:previousSource` | [键位:315](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Left | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY065 `diff:nextSource` | [键位:316](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Right | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY066 `diff:previousFile` | [键位:317](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Up, K | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY067 `diff:nextFile` | [键位:318](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Down, J | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY068 `diff:back` | [键位:319](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY069 `scroll:pageUp` | [键位:329](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 PageUp | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY070 `scroll:pageDown` | [键位:330](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 PageDown | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY071 `scroll:fullPageUp` | [键位:331](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Shift+Space, B | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY072 `scroll:fullPageDown` | [键位:332](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Space | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY073 `scroll:top` | [键位:333](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 G, Home | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY074 `scroll:bottom` | [键位:334](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Shift+G, End | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY075 `app:toggleReplTab` | [键位:344](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY076 `app:cycleDiffBase` | [键位:345](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 Ctrl+X B | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY077 `app:diffFileListUp` | [键位:346](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 Ctrl+Up, Meta+Up | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY078 `app:diffFileListDown` | [键位:347](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 Ctrl+Down, Meta+Down | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY079 `app:toggleDiffNoiseFilter` | [键位:348](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY080 `app:toggleDiffPreSession` | [键位:349](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY081 `modelPicker:decreaseEffort` | [键位:357](https://code.claude.com/docs/en/keybindings)；ModelPicker；默认 Left | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY082 `modelPicker:increaseEffort` | [键位:358](https://code.claude.com/docs/en/keybindings)；ModelPicker；默认 Right | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY083 `modelPicker:thisSessionOnly` | [键位:359](https://code.claude.com/docs/en/keybindings)；ModelPicker；默认 s | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY084 `effortSlider:decreaseEffort` | [键位:367](https://code.claude.com/docs/en/keybindings)；EffortSlider；默认 Left | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY085 `effortSlider:increaseEffort` | [键位:368](https://code.claude.com/docs/en/keybindings)；EffortSlider；默认 Right | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY086 `effortSlider:toggleUltracode` | [键位:369](https://code.claude.com/docs/en/keybindings)；EffortSlider；默认 Tab | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY087 `effortSlider:thisSessionOnly` | [键位:370](https://code.claude.com/docs/en/keybindings)；EffortSlider；默认 s | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY088 `select:next` | [键位:378](https://code.claude.com/docs/en/keybindings)；Select；默认 Down, J, Ctrl+N | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY089 `select:previous` | [键位:379](https://code.claude.com/docs/en/keybindings)；Select；默认 Up, K, Ctrl+P | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY090 `select:pageUp` | [键位:380](https://code.claude.com/docs/en/keybindings)；Select；默认 PageUp | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY091 `select:pageDown` | [键位:381](https://code.claude.com/docs/en/keybindings)；Select；默认 PageDown | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY092 `select:first` | [键位:382](https://code.claude.com/docs/en/keybindings)；Select；默认 Home | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY093 `select:last` | [键位:383](https://code.claude.com/docs/en/keybindings)；Select；默认 End | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY094 `select:accept` | [键位:384](https://code.claude.com/docs/en/keybindings)；Select；默认 Enter | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY095 `select:cancel` | [键位:385](https://code.claude.com/docs/en/keybindings)；Select；默认 Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY096 `plugin:toggle` | [键位:399](https://code.claude.com/docs/en/keybindings)；Plugin；默认 Space | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY097 `plugin:install` | [键位:400](https://code.claude.com/docs/en/keybindings)；Plugin；默认 I | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY098 `plugin:favorite` | [键位:401](https://code.claude.com/docs/en/keybindings)；Plugin；默认 F | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY099 `abovePrompt:toggle` | [键位:409](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Ctrl+X Ctrl+A | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY100 `abovePrompt:focus` | [键位:410](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Ctrl+X Tab | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY101 `abovePrompt:next` | [键位:411](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Tab | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY102 `abovePrompt:previous` | [键位:412](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Shift+Tab | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY103 `abovePrompt:press` | [键位:413](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Enter | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY104 `abovePrompt:leave` | [键位:414](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY105 `abovePrompt:highlightNext` | [键位:415](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Down | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY106 `abovePrompt:highlightPrevious` | [键位:416](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Up | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY107 `pane:scrollUp` | [键位:428](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Up | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY108 `pane:scrollDown` | [键位:429](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Down | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY109 `pane:pageUp` | [键位:430](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 PageUp | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY110 `pane:pageDown` | [键位:431](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 PageDown | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY111 `pane:top` | [键位:432](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Home | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY112 `pane:bottom` | [键位:433](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 End | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY113 `pane:grow` | [键位:434](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Ctrl+X Left, Ctrl+X Up | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY114 `pane:shrink` | [键位:435](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Ctrl+X Right, Ctrl+X Down | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY115 `pane:close` | [键位:436](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Ctrl+X X | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY116 `pane:next` | [键位:437](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY117 `pane:previous` | [键位:438](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY118 `settings:search` | [键位:448](https://code.claude.com/docs/en/keybindings)；Settings；默认 / | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY119 `settings:retry` | [键位:449](https://code.claude.com/docs/en/keybindings)；Settings；默认 R | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY120 `settings:fixUsage` | [键位:450](https://code.claude.com/docs/en/keybindings)；Settings；默认 F | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY121 `select:accept` | [键位:451](https://code.claude.com/docs/en/keybindings)；Settings；默认 Enter, Space | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY122 `confirm:no` | [键位:452](https://code.claude.com/docs/en/keybindings)；Settings；默认 Escape | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY123 `agents:switchView` | [键位:460](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+S | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY124 `agents:togglePin` | [键位:461](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+T | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY125 `agents:find` | [键位:462](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+F | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY126 `agents:rename` | [键位:463](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+R | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY127 `agents:previousGroup` | [键位:464](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+Up, Meta+Up | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY128 `agents:nextGroup` | [键位:465](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+Down, Meta+Down | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY129 `voice:pushToTalk` | [键位:479](https://code.claude.com/docs/en/keybindings)；Chat；默认 Space | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY130 `scroll:lineUp` | [键位:487](https://code.claude.com/docs/en/keybindings)；Scroll；默认 `wheelup` | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY131 `scroll:lineDown` | [键位:488](https://code.claude.com/docs/en/keybindings)；Scroll；默认 `wheeldown` | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY132 `scroll:pageUp` | [键位:489](https://code.claude.com/docs/en/keybindings)；Scroll；默认 PageUp | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY133 `scroll:pageDown` | [键位:490](https://code.claude.com/docs/en/keybindings)；Scroll；默认 PageDown | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY134 `scroll:top` | [键位:491](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Ctrl+Home | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY135 `scroll:bottom` | [键位:492](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Ctrl+End | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY136 `scroll:halfPageUp` | [键位:493](https://code.claude.com/docs/en/keybindings)；Scroll；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY137 `scroll:halfPageDown` | [键位:494](https://code.claude.com/docs/en/keybindings)；Scroll；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY138 `scroll:fullPageUp` | [键位:495](https://code.claude.com/docs/en/keybindings)；Scroll；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY139 `scroll:fullPageDown` | [键位:496](https://code.claude.com/docs/en/keybindings)；Scroll；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY140 `selection:copy` | [键位:497](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Ctrl+Shift+C / Cmd+C | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY141 `selection:clear` | [键位:498](https://code.claude.com/docs/en/keybindings)；Scroll；默认 (unbound) | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY142 `selection:extendLeft` | [键位:499](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+Left | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY143 `selection:extendRight` | [键位:500](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+Right | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY144 `selection:extendUp` | [键位:501](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+Up | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY145 `selection:extendDown` | [键位:502](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+Down | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY146 `selection:extendLineStart` | [键位:503](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+Home | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
| CL-KEY147 `selection:extendLineEnd` | [键位:504](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+End | 在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；**待实际键位行为验收** |
