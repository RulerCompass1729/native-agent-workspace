# 竞品关系与研究边界

As of 2026-10-17。此前宽表已覆盖 53 个候选条目，包含同一产品系列及邻近产品，不是 53 家独立公司。本仓库保留决定当前架构的对照；不复制私人调研原始资料。

结论：直接重合存在。多 agent、桌面 GUI、终端嵌入都不是独有概念。机会要通过用户少搬运、少管理、少重复授权来验证，不能从“未发现全满足的产品”推导市场空白。

| 对照产品 | 重叠及有用参照 | 本次证据的限制 | 复用边界 |
| --- | --- | --- | --- |
| [Orca](https://github.com/stablyai/orca) | 已有 PTY 切 Chat 保持原 PTY；Teams 专用适配与跨 agent mailbox | 新建 structured Chat 是另一条 SDK 路径；未做本项目全场景运行验收 | 顶层 MIT；具体文件、依赖及素材仍需逐项审查 |
| [Nimbalyst](https://github.com/Nimbalyst/nimbalyst) | 普通成果工作台；交互式 Claude PTY 与图形输入；Codex app-server | 改写部分提问/提示语义；完整 Teams 与总费用未验 | 顶层 MIT；不整包复制 |
| [Backchat](https://github.com/openma-ai/backchat) | 多 agent 同一 conversation、side chats、session 引用及能力协商 | ACP 实现路径不证明完整 native Teams；仍为预发布 | 总体许可未确认，不复用代码 |
| [Howse](https://howse.swimit.io/) | Claude + Codex + 人类，线程、交接与人工决策 | 应用闭源；官方旧演示不等于当前版本整夜验收 | 研究交互，不复制实现或素材 |
| [cmux](https://github.com/manaflow-ai/cmux) | 原生 Mac 终端、多视图、Teams 与消息机制 | 桌面 transcript sidecar 和移动端输入需区分；新功能发行覆盖未全核 | 顶层 GPL-3.0-or-later，列明部分 BUSL-1.1；不当宽松许可组件直接引入 |
| [Maestro](https://github.com/RunMaestro/Maestro) | Group Chat、moderator 与交互式选项 | 默认 headless；应用自建团队不代表原生完整 Teams | AGPL-3.0；当前只作产品参考 |
| [Superset](https://github.com/superset-sh/superset) | 开发工作台、ACP Chat 与原生终端 | 不同路径不能拼成已证实的同一 session | Elastic License 2.0；当前只作产品参考 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 插件化桌面和 UI、执行及 session 服务 | 现成 Claude/Codex 插件是一次性 subagent；尚无本产品运行证明 | 核心 MIT，依赖/品牌另查；首选基础候选 |

## 关键源码证据

- Orca `v1.4.229`：[保留 PTY 的视图切换](https://github.com/stablyai/orca/blob/a0cd1644f320f1327f7495650a816111b495f3cd/src/renderer/src/components/terminal-pane/use-terminal-pane-chat-state.ts#L122)、[两种发送路径](https://github.com/stablyai/orca/blob/a0cd1644f320f1327f7495650a816111b495f3cd/src/renderer/src/components/native-chat/NativeChatComposer.tsx#L249)、[Teams 适配](https://github.com/stablyai/orca/blob/a0cd1644f320f1327f7495650a816111b495f3cd/src/main/runtime/claude-agent-teams-tmux-dispatcher.ts#L102)。不能把“有 SDK”误说成全产品不支持交互式 CLI。
- Nimbalyst：[稳定版启动配置](https://github.com/Nimbalyst/nimbalyst/blob/v0.81.7/packages/electron/src/main/services/ai/claudeCliSpawnConfig.ts)、[实际提交](https://github.com/Nimbalyst/nimbalyst/blob/04dd31f0329a00a22bd3119c9818c98112f5157f/packages/electron/src/main/services/ai/claudeCliSubmit.ts)、[Codex provider](https://github.com/Nimbalyst/nimbalyst/blob/04dd31f0329a00a22bd3119c9818c98112f5157f/packages/runtime/src/ai/server/providers/OpenAICodexProvider.ts#L209)。仅启动配置在 stable 与所读 HEAD 对照一致，其他链路不冒充全部稳定版实测。
- Backchat：[ACP session manager](https://github.com/openma-ai/backchat/blob/37f6f6c4e29fbb9ec7efa4e8b46934663449acef/src/main/session-manager.ts#L1809)、[引用其他 session 的上下文](https://github.com/openma-ai/backchat/blob/37f6f6c4e29fbb9ec7efa4e8b46934663449acef/src/main/session-prompt-context.ts)。底层全部 adapter 尚未追完。
- cmux：[桌面只读 transcript 视图](https://github.com/manaflow-ai/cmux/blob/ef1a5a253da72a0d7695490db9866fdb7a85a19a/Sources/Workspace%2BAgentChat.swift)、[移动端发送](https://github.com/manaflow-ai/cmux/blob/ef1a5a253da72a0d7695490db9866fdb7a85a19a/Sources/TerminalController%2BMobileChat.swift#L273)、[分区许可](https://github.com/manaflow-ai/cmux/blob/ef1a5a253da72a0d7695490db9866fdb7a85a19a/LICENSE)。

## 我们要验证的组合

独立 native session 可长期存在；临时加入协作后可以原样脱出；同一 session 的 GUI/TUI 和独立窗口自然共存；真人随时改变方向；后台交接有范围、有终点、无暗中额外推理。单人使用与非代码任务也必须完整。

这里的“组合”是产品验收方向，不是新颖性、专利性或竞品没有该功能的断言。本次未完成所有竞品的会话拖入/脱出实测，不能宣称该交互首创。

## 以后只在这些情况下补竞调

遇到一个具体交互或协议问题时，定点检查最相关产品；上游新增 attach、Teams 或 session API 时复核兼容路线；准备复用某段实现时核其精确版本与许可。当前不让用户逐款体验，不重复按 stars 排名，不为竞品已有功能而放弃自己的使用体验目标。

未完成的验证包括键鼠、输入法、可访问性、长会话性能、全 fleet 停止、休眠恢复和同等任务费用。源码与官方文档只能支持相应机制，不能代替这些验收。版本、功能和许可会变化。
