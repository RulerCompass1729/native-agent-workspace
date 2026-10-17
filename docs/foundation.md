# 基础选型决定

As of 2026-10-17。决定：**独立仓库承载产品，DeepSeek Harness 作为首选集成候选**。暂不复制完整上游，不安装 runtime，不声称已完成接入。

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

## 采用什么边界

本产品自行定义 session、room、membership、共享授权和控制语义。DSH 候选承担桌面/UI 插件与经过审查的底层组件；不让业务身份被 DSH 模型循环拥有。Claude 与 Codex 不必先经过一个 DeepSeek 模型的转述。

优先尝试扩展包或 adapter 接入上游，以版本固定的依赖或可审计补丁维持边界。若确实需要改上游，再创建明确保留来源和许可的 fork；独立仓库不是抹去来源的办法。

如果长期主 session 必须侵入重写 DSH 核心、增加中间模型，或无法保持完整 native Teams，则停止扩大该集成，改为较薄的独立桌面外壳加必要组件。此为后备路线，不在准备阶段同时建设两套架构。

## 第一个技术证明

仅证明一个原生 session 在独立视图、加入房间、脱出房间与 GUI/TUI 视图之间保持身份、fleet、待审批状态，不增加壳层模型调用；并证明房间退出不会触发 owner cleanup。随后在同一证明中连接第二个原生 session 做一次定向交接。

先用真实交互式 Claude 检验最硬限制，再用 Codex 验证同一控制层可扩展。测试不要求完成美术、编辑器或插件市场。

源码检查不能解决仍未验证的原生 GUI 输入、动态 fleet 事件、跨视图单写入者、崩溃恢复和费用计量。进入产品功能开发前必须记录实际通过与失败边界。

## 版权与维护影响

DSH 核心 MIT 支持商业复用并要求保留许可与版权通知；其依赖并非全部 MIT，官方品牌也有独立规范。先接入必要组件，比把包含模型、办公引擎、安装器和遥测的完整发行版都搬过来更容易界定需要承担的维护与分发义务。详见 [licensing](licensing.md)。
