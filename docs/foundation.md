# 基础选型决定

As of 2026-10-17。决定：**独立仓库承载产品，以 DeepSeek Harness 为 UI 基础**。本地 demo 已采用固定版本 `@deepseek-ai/dsh@0.2.1-rc.2` Web composition、client 插件、布局/主题/Markdown；Electron 承载该界面，独立服务持有原生进程。以下源码表记录选型依据，不把上游的现成 subagent 插件冒充本产品主会话。

2026-11-10 状态：以上 2026-10-17 选型记载及下表保留为当时的技术证据；新批准的分层方向见本页下文和 [逐字产品记录](product.md#2026-11-10-已批准的方向与边界)。本次文档对齐未重验旧源码表，也不把方向当作已实现。

## 为什么不直接把 DSH 改名发布

已核查版本：`deepseek-ai/deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317`。代码版本标记 `0.2.1-rc.2`，不等同于稳定发行认证。

| 实际源文件 | 已证明的机制 | 对本产品的影响 |
| --- | --- | --- |
| [UI layout](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-layout/src/client/index.ts#L158) | 注册 root/sidebar/main/rightbar 等视图插槽 | 有复用 UI 插件装配的基础 |
| [AgentRegistry](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/index.ts#L360) | 单一 factory 槽位，create/resume 委托其实现；也有 register 既存 agent 路径 | 可以继续调查接入点，不能声称异构原生主 session 插上即用 |
| [UiSession](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-session/src/client/index.ts#L266) | 基础 UI source 绑定其 SessionBinding 和 projection | 原生外部 session 要明确映射与事件适配 |
| [Claude runner](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent-claude-code/src/run.ts#L325) | SDK 一次性任务，persistSession=false，禁用部分人工交互 | 不直接用作持久、交互式 Claude 主会话 |
| [Codex wire](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent-codex/src/wire.ts#L289) | 实际 app-server 的 thread/start 使用 ephemeral=true | 真实接入不等于持久主 session 已具备 |
| [terminal service](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/terminal/terminal/src/index.ts#L318) | PTY 归精确 Agent owner；owner dispose 会清理 PTY | 本产品不能让 Room 成为原生进程 owner |
| [terminal-bash](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/terminal/terminal-bash/src/index.ts#L202) | spawnTerminal 当前用 terminalType=dumb | 不代表已具备全屏 native TUI 与完整键鼠输入 |
| [desktop main](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/src/main.ts#L409) | 存在产品 analytics 状态与 report 路径 | 不能未经检查沿用整套发行配置；未审计其全部默认采集行为 |

Anthropic 当前说明完整 Teams 的 teammates 需要交互式 session，SDK/print 不能替代；这限制的是现成适配路径，不是否定 DSH 的全部扩展能力。[官方文档](https://code.claude.com/docs/en/agent-teams#enable-agent-teams)

## 2026-11-10 已批准的分层方向

用户 2026-11-10 晚原话：「那为啥不用 DSH 作为原生的壳？我本来也不打算用 codex 作为壳」。完整原话和其他已批准句子保存在 [产品记录](product.md#2026-11-10-已批准的方向与边界)，不在此缩写或改字。

2026-11-10 22:58，Claude 终端问「『上层大管家放在 DSH 上，下层会话服务保持独立』这个分法，你同意吗？」；用户实际答复对应的 2026-11-10 23:02 问题是「分两层的方案是否同意」，确认结果见产品记录中的产品决定确认条目。上层大管家放在 DSH 上、下层会话服务保持独立，是已批准的方向；如何落地待证明，不是现有适配已完成的声明。

用户 2026-11-10 晚批准的完整句子：「规则引擎永远不调模型；NAW 里唯一会调模型的自带部件是你指定的大管家，独立进程、单独计量、看得见、能关、默认是空的」。同晚批准的读取边界：「大管家可看所有空间的队列正文和交付记录，永不看会话正文」。这些边界不把会话服务、会话正文或所有控制权限交给 DSH 的模型循环。

第 9 节将第一条完整分层说明标记为已批准，原样保留如下：

分两层。上层是大管家，放在 DSH 上：agent 循环、DeepSeek 适配、只经 native_workspace 接 NAW 的控制工具。下层是会话服务，继续独立于 DSH：托管各家 TUI、换会话、版本门、空间和队列。

22:58 的提问与 23:02 实际问题一并记录，批准的完整方案按第 9 节保留，落地仍需验证，见产品实施待验 V14。第二条起的不装内置执行工具／sub-agent／压缩／上报，以及端点和请求头取舍，仍是 Claude 终端的安排和待证明项。工具取舍与现行 V7 的完整入口能力要求存在冲突，见 V18，需用户决定；其他 agent 可操控 NAW 的具体范围仍未定，原有本人确认门照旧。

## 采用什么边界

**2026-10-17 历史边界，2026-11-10 取代范围：**下面原文保留。原来的 DSH UI 使用记载继续描述当时已接入的组件；「DSH 承担 UI 插件、布局、主题与 Markdown 等已接入的组件；不让业务身份被 DSH 模型循环拥有」不再作为排除 DSH 上层大管家的绝对限制。边界按 23:1x 批准的分层处理，下层会话服务保持独立。

本产品自行定义 session、room、membership、共享授权和控制语义。DSH 承担 UI 插件、布局、主题与 Markdown 等已接入的组件；不让业务身份被 DSH 模型循环拥有。Claude 与 Codex 不必先经过一个 DeepSeek 模型的转述。

优先尝试扩展包或 adapter 接入上游，以版本固定的依赖或可审计补丁维持边界。若确实需要改上游，再创建明确保留来源和许可的 fork；独立仓库不是抹去来源的办法。

如果长期主 session 必须侵入重写 DSH 核心、增加中间模型，或无法保持完整 native Teams，则停止扩大该集成，改为较薄的独立桌面外壳加必要组件。此为后备路线，不在准备阶段同时建设两套架构。

2026-11-10 对旧后备路线的限定：上段薄壳方案仍保留为 2026-10-17 的后备记录；它不自动取代用户 23:1x 批准的 DSH 上层方向。若落地证明遇到问题，按 [产品张力](product.md#与愿景的张力待用户定) 记录和交用户决定；本文不把待证明写成已失败或另一个架构已获批准。

## 第一个技术证明

仅证明一个原生 session 在独立视图、加入房间、脱出房间与 GUI/TUI 视图之间保持身份、fleet、待审批状态，不增加壳层模型调用；并证明房间退出不会触发 owner cleanup。随后在同一证明中连接第二个原生 session 做一次定向交接。

先用真实交互式 Claude 检验最硬限制，再用 Codex 验证同一控制层可扩展。测试不要求完成美术、编辑器或插件市场。

源码检查不能解决仍未验证的原生 GUI 输入、动态 fleet 事件、跨视图单写入者、崩溃恢复和费用计量。实际通过与未测边界见 [demo](../demo.md)；这不是完整 native fleet 或成本等价性的证明。

## 版权与维护影响

DSH 核心 MIT 支持商业复用并要求保留许可与版权通知；其依赖并非全部 MIT，官方品牌也有独立规范。先接入必要组件，比把包含模型、办公引擎、安装器和遥测的完整发行版都搬过来更容易界定需要承担的维护与分发义务。详见 [licensing](licensing.md)。
