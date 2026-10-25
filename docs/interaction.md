# 交互草案

As of 2026-10-18。下面先记录 alpha.17 当前交互；后续章节仍包含设计目标，
不能把草案中的全部能力当作已经实现。测试范围见 [审查与验收](review.md)。

## 2026-10-24：GUI 事实验收与 U17 原生能力审计

问题：GUI 必须准确反映同一个原生会话的内容和状态，接入差异必须明示。
现有机制：`app/adapters.cjs`、`app/codex-terminal-bridge.cjs`、既有阅读区与同屏 xterm。
最小增量：按完整用户任务验证核心事实；只修错位、丢失、矛盾和未经说明的接入限制。
不做会坏什么：把排队当送达、把终端退出当会话结束，或用加工文字掩盖原生事实。

**当前完成标准已由用户收窄，不再以逐条重做或执行所有 TUI 功能为目标。**
下方 U17 表是能力归属审计表，每行标明“GUI 原样”或“同屏原生 TUI”；命令、键位不再逐行执行验收。
Codex 归属审计已通过一次 headless Fable 独立复核（265 行均有归属）；这不批准尚未验收的 GUI 事实。
GUI 事实按下列用户任务验收，每项需要安装版、零付费推理和独审证据。
用户视觉验收、物理输入法、外部运行中会话接入不阻塞。**当前目标仍未完成。**

| GUI 事实 | 必须保持的含义 | 安装版证据与状态 |
| --- | --- | --- |
| 线程身份 | new/resume/fork 跟随明确原生结果；退出显示端后继续同一线程，不靠全局 started 猜身份 | 复用 alpha.91 Codex164 安装版上下文任务，仅身份范围；Fable review08 核对相关代码未变并通过，不复用旧完成文案 |
| 状态 | running/idle/ended/等待审批/等待回答/已中断；终端退出不冒充模型结束，enqueue 不冒充接受 | `C164-TOOLS-01` 审批→执行→idle、alpha.94 问题等待状态经 review08 通过；`C164-PLAN-01` 原生 Escape 的 interrupted 与复开经 review09 通过；原生断流/retry→idle 经 Fable review10 通过。`C164-END-01` 安装 alpha.97 受控 thread/closed 事件验证已结束、身份/草稿保留且零派发；不冒充实际 CLI 关闭证据；Fable review13 按 runtime→GUI 范围通过 |
| 用户输入、助手正文 | 正文与来源不改写，不跨线程拼接；真实流式边界才结束消息块 | 复用 alpha.91 上下文任务、alpha.94 原文任务，经 Fable review08 核证；alpha.96 输入回归经 review07、原生 Plan 正文与截断经 review09 通过 |
| 工具调用与结果 | 原生公开字段、正文和终态；缺失或截断不伪装完整 | `C164-TOOLS-01` 安装 alpha.96 / Codex164：实际文件审批、写入与读取；原生 add/diff 和输出正文、重载与同线程恢复通过；Fable review08 通过。alpha.94 搜索只证明原文标题和 query，不当作搜索结果正文证据 |
| 问题与选项 | 原文及对应等待状态；交互由同屏 TUI 处理 | alpha.94 Codex164 Plan 问题/回答安装版证据；Fable review08 通过原文和等待状态范围，不据此覆盖所有问题变体 |
| Plan | GUI 原样呈现 proposed plan 正文与当前模式；update_plan 步骤进度、接受/修改在同屏 TUI，不补写模型计划 | `C164-PLAN-01` 安装 alpha.96 / Codex164：原生 Plan 模式、流式正文、同块完成、共享范围、原生截断与复开通过；四个固定任务和一个标题响应，零付费；Fable review09/10 通过。步骤进度没有 GUI 投影，不据此宣称已实现 |
| 错误 | 原生公开错误正文原样显示；可重试不等于失败结束；TUI 自身排版仍由 TUI 保留 | `C164-RETRY-01` 安装 alpha.96 / Codex164：实际断流、原生 willRetry、GUI 原文、TUI 重连、同线程恢复及计时隐藏通过，Fable review10 通过。`C164-FAIL-01` 安装 alpha.97 / Codex164：不可重试的拒绝保留原文和 failed 边界，无虚构助手回复/自动重发；下一条显式 GUI 任务在同线程完成。两次本地任务请求和一个标题响应，零付费；Fable review13 通过 |
| 模型与 effort | 只显示当前原生报告，线程改变后不沿用旧线程字段 | `C164-SET-01` 安装 alpha.95 的三次原生 model/effort 切换，GUI 标题一致；零推理；Fable review08 核证复用通过 |
| 用量 | 只表示原生报告的线程/周期范围；未知保持未知，不混算标题或他人线程 | 安装 alpha.91 / Codex164 定向协作任务验证实际用量与 session/room 范围；同版本合成 UI 验证未知非零与刷新无派发；Fable review08 核证最终通过记录，排除失败试次 |
| 回合起止、耗时 | GUI 运行计时只用已确认的原生开始时间，未知不显示；完成时间/耗时与 Worked/Cooked 文案保留同屏 TUI，不由 GUI 重构 | `C164-PLAN-01` 安装版完成/截断复开无运行计时或拼造 footer；`C164-TIME-01` 安装版受控事件验证未知→原生开始时间→未知→空闲的显示；零推理，Fable review10 通过 |
| Claude310 | 由 `.local/lanes/claude310.md` lane 提供已审改动与证据；主线程合并、装机验收、推送 | 已合并其文档与 branch 改动；安装 alpha.97 原生分支→GUI 继续通过，Fable review12 通过。其他 Claude 事实仍待 lane 交付，不重复实现 |

### Codex 0.164 接入差异（明确披露）

- 原生 CLI 使用本应用的私有 `--remote` 端点，不是 Codex 自己的默认本地 daemon。
  原生 `/worktree` 和 new/fork 中的本地工作树分支因此不可用；本应用没有等价 GUI 工作树管理。
- 本地 daemon 专属的空编辑框 Left 导航与提示不可用；原生 `/agents` command center 仍可使用。
  `/daemon` 菜单可查看，但本应用不接管用户全局 daemon 的维护生命周期。
- 本地图片经原生快照发送，非原路径透传。隔离 PNG 路径粘贴与发送已证字节不变；
  系统图片剪贴板、所有媒体格式与外部图片服务未据此宣称已验。
- `--add-dir`、额外 `writable_roots` 的显式启动覆盖被原生远程模式拒绝，应在原生服务端配置。
  本应用不复制 credentials、不改变 CODEX_HOME 去冒充本地模式，也不静默启动第二个 agent。
- 启动禁用 analytics；GUI 首次创建线程时加入本应用的定向消息动态工具，原生优先创建的线程不假定拥有它。
  native side/subagent 视图仍由 TUI 管理，GUI 仅依据已确认的主线程切换结果跟随，不把全局活动冒充当前线程。
- Mac Option 默认保留字符/重音输入。Option+字母的 Alt 快捷键受终端编码限制，使用原生替代绑定或命令；
  不强制把 Option 设成 Meta。没有新增设置面板，也不宣称支持全部自定义键盘协议。
- 没有键盘模式元数据的旧后台保留旧编码；本批增强按键验收不套用于原有 0.163 后台。

### 审计来源与证据边界

源码固定为 [Codex rust-v0.164.0](https://github.com/openai/codex/tree/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs)，
提交 `6aaac694803004a63c6f393d153c96d22521a6b9`。标识索引
[`codex164-inventory.json`](../scripts/fixtures/codex164-inventory.json) 保留 65 个命令、155 个可配置运行时动作、
14 个固定动作、19 种消息项、11 个请求、87 个通知及 182 个功能项。
协议/配置含内部或已移除项；数量不代表实现或验收数。原生配置目录有 154 项。
7 个来源哈希与 505 条标识行已与固定源码核对，无错位。完整性仍按源码审计，不再逐行做运行测试。

既有安装版证据仅在相关运行时、适配器和行为未变时复用，写明原版本和适用范围。
`C164-INV-01` 是空闲/忙碌/side 菜单与 keymap 发现；`C164-MENU-01` 是 17 个菜单打开/取消；
`C164-SET-01` 是三次模型/effort 切换；`C164-IMG-01` 是隔离 PNG 路径附件和同一回复。
前两者不证明每个子操作执行成功。图片一轮含一个固定任务与一个原生标题响应，付费推理为零。
早期 alpha.96 的 32 键录像包含未经批准的强制 Meta 方案，**不作为最终修复通过证据**；
独审要求恢复 Option 字符输入后，修正安装版的六项按键接收、多行草稿、重载与合成输入已通过；
`C164-INPUT-02` 不涉及模型请求，已通过同一审查官的 Fable 增量复核。物理输入法未据此宣称已验。
失败证据均保留。

GUI 字段的安装版验收、审计表的一次复核、未实现功能的披露，是三个不同要求，不互相顶替。
原始截图、字节流、录像及用户会话资料留在私有验证目录，不进入公开仓库。

Claude 310 的能力归属与启动差异见 [Claude lane 审计表](u17-claude310.md)。
此处合并其已审文档，不代表 Claude 事实实现与安装版验收已经完成。

| ID／功能 | 官方来源／条件 | GUI 或同屏原生 TUI；原因／当前缺口 | 安装版证据与状态 |
| --- | --- | --- | --- |
| C-CMD01 `/model` | [命令:15](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L15)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD02 `/presets` | [命令:16](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L16)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD03 `/daybreak` | [命令:17](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L17)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD04 `/ide` | [命令:18](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L18)；源规则 是/是/是/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD05 `/permissions` | [命令:19](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L19)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD06 `/keymap` | [命令:20](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L20)；源规则 是/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD07 `/vim` | [命令:21](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L21)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD08 `/setup-default-sandbox` | [命令:23](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L23)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD09 `/experimental` | [命令:24](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L24)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD10 `/approve` | [命令:26](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L26)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD11 `/memories` | [命令:27](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L27)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD12 `/skills` | [命令:28](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L28)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD13 `/import` | [命令:29](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L29)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD14 `/hooks` | [命令:30](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L30)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD15 `/review` | [命令:31](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L31)；源规则 是/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD16 `/rename` | [命令:32](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L32)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD17 `/new` | [命令:33](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L33)；源规则 是/否/否/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD18 `/archive` | [命令:34](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L34)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD19 `/delete` | [命令:35](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L35)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD20 `/resume` | [命令:36](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L36)；源规则 是/是/否/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD21 `/fork` | [命令:37](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L37)；源规则 是/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD22 `/worktree` | [命令:38](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L38)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；**产品接入缺口：本地有，安装版无** | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD23 `/app` | [命令:39](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L39)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD24 `/init` | [命令:40](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L40)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD25 `/compact` | [命令:41](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L41)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD26 `/config` | [命令:42](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L42)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD27 `/recap` | [命令:43](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L43)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD28 `/plan` | [命令:44](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L44)；源规则 是/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD29 `/voice` | [命令:45](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L45)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD30 `/goal` | [命令:46](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L46)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD31 `/agents` | [命令:47](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L47)；源规则 否/是/是/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD32 `/side` | [命令:48](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L48)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD33 `/btw` | [命令:49](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L49)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD34 `/copy` | [命令:50](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L50)；源规则 否/是/是/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD35 `/export` | [命令:51](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L51)；源规则 是/否/是/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD36 `/raw` | [命令:52](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L52)；源规则 是/是/是/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD37 `/tui` | [命令:53](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L53)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD38 `/diff` | [命令:54](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L54)；源规则 否/是/是/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD39 `/mention` | [命令:55](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L55)；源规则 否/是/是/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD40 `/status` | [命令:56](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L56)；源规则 否/是/是/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD41 `/daemon` | [命令:57](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L57)；源规则 否/是/是/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD42 `/warnings` | [命令:58](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L58)；源规则 否/是/是/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD43 `/cd` | [命令:59](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L59)；源规则 是/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD44 `/pwd` | [命令:61](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L61)；源规则 是/是/是/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD45 `/usage` | [命令:62](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L62)；源规则 是/是/是/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD46 `/debug-config` | [命令:63](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L63)；源规则 否/是/否/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD47 `/title` | [命令:64](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L64)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD48 `/statusline` | [命令:65](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L65)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD49 `/theme` | [命令:66](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L66)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD50 `/pets` | [命令:68](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L68)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD51 `/mcp` | [命令:69](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L69)；源规则 是/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD52 `/apps` | [命令:70](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L70)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD53 `/plugins` | [命令:71](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L71)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD54 `/logout` | [命令:72](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L72)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD55 `/quit` | [命令:73](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L73)；源规则 否/是/否/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD56 `/exit` | [命令:74](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L74)；源规则 否/是/否/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD57 `/feedback` | [命令:75](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L75)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD58 `/rollout` | [命令:76](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L76)；源规则 否/是/否/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD59 `/ps` | [命令:77](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L77)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD60 `/stop` | [命令:79](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L79)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD61 `/clear` | [命令:80](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L80)；源规则 是/否/否/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD62 `/test-approval` | [命令:81](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L81)；源规则 否/是/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD63 `/subagents` | [命令:83](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L83)；源规则 否/是/否/是 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD64 `/debug-m-drop` | [命令:86](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L86)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-CMD65 `/debug-m-update` | [命令:88](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/slash_command.rs#L88)；源规则 否/否/否/否 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY001 `global.open_agents` | [键位:281](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L281) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY002 `global.open_transcript` | [键位:282](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L282) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY003 `global.find_transcript` | [键位:283](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L283) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY004 `global.focus_activity` | [键位:284](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L284) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY005 `global.open_warnings` | [键位:285](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L285)；运行时动作 | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY006 `global.open_external_editor` | [键位:286](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L286) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY007 `global.copy` | [键位:287](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L287) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY008 `global.clear_terminal` | [键位:288](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L288) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY009 `global.toggle_vim_mode` | [键位:289](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L289) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY010 `global.toggle_fast_mode` | [键位:290](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L290) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY011 `global.toggle_raw_output` | [键位:291](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L291) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY012 `global.toggle_side_conversation` | [键位:292](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L292) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY013 `chat.open_presets` | [键位:295](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L295) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY014 `chat.toggle_voice` | [键位:296](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L296) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY015 `chat.interrupt_turn` | [键位:297](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L297) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY016 `chat.decrease_reasoning_effort` | [键位:298](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L298) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY017 `chat.increase_reasoning_effort` | [键位:299](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L299) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY018 `chat.previous_permission_mode` | [键位:300](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L300) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY019 `chat.next_permission_mode` | [键位:301](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L301) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY020 `chat.edit_queued_message` | [键位:302](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L302) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY021 `chat.prompt_stack_back` | [键位:303](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L303) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY022 `chat.skip_question` | [键位:304](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L304) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY023 `chat.toggle_voice_mute` | [键位:306](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L306) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY024 `composer.submit` | [键位:308](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L308) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY025 `composer.queue` | [键位:309](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L309) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY026 `composer.toggle_shortcuts` | [键位:310](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L310) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY027 `composer.history_search_previous` | [键位:311](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L311) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY028 `composer.history_search_next` | [键位:312](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L312) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY029 `editor.insert_newline` | [键位:315](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L315) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY030 `editor.move_left` | [键位:316](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L316) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY031 `editor.move_right` | [键位:317](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L317) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY032 `editor.move_up` | [键位:318](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L318) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY033 `editor.move_down` | [键位:319](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L319) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY034 `editor.move_word_left` | [键位:320](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L320) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY035 `editor.move_word_right` | [键位:321](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L321) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY036 `editor.move_line_start` | [键位:322](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L322) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY037 `editor.move_line_end` | [键位:323](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L323) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY038 `editor.delete_backward` | [键位:324](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L324) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY039 `editor.delete_forward` | [键位:325](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L325) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY040 `editor.delete_backward_word` | [键位:326](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L326) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY041 `editor.delete_forward_word` | [键位:327](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L327) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY042 `editor.kill_line_start` | [键位:328](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L328) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY043 `editor.kill_whole_line` | [键位:329](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L329) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY044 `editor.kill_line_end` | [键位:330](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L330) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY045 `editor.yank` | [键位:331](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L331) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY046 `vim_normal.enter_insert` | [键位:334](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L334) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY047 `vim_normal.append_after_cursor` | [键位:335](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L335) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY048 `vim_normal.append_line_end` | [键位:336](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L336) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY049 `vim_normal.insert_line_start` | [键位:337](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L337) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY050 `vim_normal.open_line_below` | [键位:338](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L338) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY051 `vim_normal.open_line_above` | [键位:339](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L339) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY052 `vim_normal.enter_replace_mode` | [键位:340](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L340) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY053 `vim_normal.move_left` | [键位:341](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L341) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY054 `vim_normal.move_right` | [键位:342](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L342) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY055 `vim_normal.move_up` | [键位:343](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L343) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY056 `vim_normal.move_down` | [键位:344](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L344) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY057 `vim_normal.move_word_forward` | [键位:345](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L345) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY058 `vim_normal.move_word_backward` | [键位:346](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L346) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY059 `vim_normal.move_word_end` | [键位:347](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L347) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY060 `vim_normal.move_line_start` | [键位:348](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L348) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY061 `vim_normal.move_line_end` | [键位:349](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L349) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY062 `vim_normal.find_forward` | [键位:350](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L350) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY063 `vim_normal.find_backward` | [键位:351](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L351) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY064 `vim_normal.till_forward` | [键位:352](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L352) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY065 `vim_normal.till_backward` | [键位:353](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L353) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY066 `vim_normal.jump_top` | [键位:354](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L354) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY067 `vim_normal.jump_bottom` | [键位:355](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L355) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY068 `vim_normal.delete_char` | [键位:356](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L356) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY069 `vim_normal.replace_char` | [键位:357](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L357) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY070 `vim_normal.repeat_last_change` | [键位:358](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L358) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY071 `vim_normal.substitute_char` | [键位:359](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L359) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY072 `vim_normal.delete_to_line_end` | [键位:360](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L360) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY073 `vim_normal.change_to_line_end` | [键位:361](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L361) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY074 `vim_normal.yank_line` | [键位:362](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L362) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY075 `vim_normal.paste_after` | [键位:363](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L363) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY076 `vim_normal.start_delete_operator` | [键位:364](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L364) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY077 `vim_normal.start_yank_operator` | [键位:365](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L365) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY078 `vim_normal.start_change_operator` | [键位:366](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L366) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY079 `vim_normal.undo` | [键位:367](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L367) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY080 `vim_normal.redo` | [键位:368](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L368) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY081 `vim_normal.cancel_operator` | [键位:369](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L369) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY082 `vim_search.forward` | [键位:371](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L371) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY083 `vim_search.backward` | [键位:371](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L371) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY084 `vim_search.next` | [键位:371](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L371) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY085 `vim_search.previous` | [键位:371](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L371) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY086 `vim_operator.delete_line` | [键位:373](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L373) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY087 `vim_operator.yank_line` | [键位:374](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L374) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY088 `vim_operator.motion_left` | [键位:375](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L375) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY089 `vim_operator.motion_right` | [键位:376](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L376) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY090 `vim_operator.motion_up` | [键位:377](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L377) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY091 `vim_operator.motion_down` | [键位:378](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L378) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY092 `vim_operator.motion_word_forward` | [键位:379](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L379) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY093 `vim_operator.motion_word_backward` | [键位:380](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L380) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY094 `vim_operator.motion_word_end` | [键位:381](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L381) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY095 `vim_operator.motion_line_start` | [键位:382](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L382) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY096 `vim_operator.motion_line_end` | [键位:383](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L383) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY097 `vim_operator.motion_find_forward` | [键位:384](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L384) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY098 `vim_operator.motion_find_backward` | [键位:385](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L385) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY099 `vim_operator.motion_till_forward` | [键位:386](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L386) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY100 `vim_operator.motion_till_backward` | [键位:387](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L387) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY101 `vim_operator.motion_jump_top` | [键位:388](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L388) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY102 `vim_operator.motion_jump_bottom` | [键位:389](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L389) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY103 `vim_operator.select_inner_text_object` | [键位:390](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L390) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY104 `vim_operator.select_around_text_object` | [键位:391](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L391) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY105 `vim_operator.cancel` | [键位:392](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L392) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY106 `vim_text_object.word` | [键位:395](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L395) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY107 `vim_text_object.big_word` | [键位:396](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L396) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY108 `vim_text_object.parentheses` | [键位:397](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L397) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY109 `vim_text_object.brackets` | [键位:398](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L398) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY110 `vim_text_object.braces` | [键位:399](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L399) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY111 `vim_text_object.double_quote` | [键位:400](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L400) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY112 `vim_text_object.single_quote` | [键位:401](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L401) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY113 `vim_text_object.backtick` | [键位:402](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L402) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY114 `vim_text_object.cancel` | [键位:403](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L403) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY115 `pager.scroll_up` | [键位:406](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L406) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY116 `pager.scroll_down` | [键位:407](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L407) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY117 `pager.page_up` | [键位:408](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L408) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY118 `pager.page_down` | [键位:409](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L409) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY119 `pager.half_page_up` | [键位:410](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L410) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY120 `pager.half_page_down` | [键位:411](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L411) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY121 `pager.jump_top` | [键位:412](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L412) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY122 `pager.jump_bottom` | [键位:413](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L413) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY123 `pager.close` | [键位:414](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L414) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY124 `pager.close_transcript` | [键位:415](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L415) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY125 `pager.find` | [键位:416](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L416) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY126 `list.move_up` | [键位:419](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L419) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY127 `list.move_down` | [键位:420](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L420) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY128 `list.move_left` | [键位:421](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L421) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY129 `list.move_right` | [键位:422](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L422) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY130 `list.page_up` | [键位:423](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L423) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY131 `list.page_down` | [键位:424](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L424) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY132 `list.jump_top` | [键位:425](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L425) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY133 `list.jump_bottom` | [键位:426](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L426) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY134 `list.accept` | [键位:427](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L427) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY135 `list.cancel` | [键位:428](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L428) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY136 `agents.resume` | [键位:431](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L431) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY137 `agents.search` | [键位:432](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L432) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY138 `agents.new_task` | [键位:433](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L433) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY139 `agents.new_worktree` | [键位:434](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L434) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY140 `agents.fork` | [键位:435](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L435) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY141 `agents.rename` | [键位:436](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L436) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY142 `agents.stop` | [键位:437](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L437) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY143 `agents.archive` | [键位:438](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L438) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY144 `agents.delete` | [键位:439](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L439) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY145 `agents.hide` | [键位:440](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L440) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY146 `agents.toggle_pin` | [键位:441](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L441) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY147 `agents.toggle_grouping` | [键位:442](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L442) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY148 `approval.open_fullscreen` | [键位:445](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L445) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY149 `approval.open_thread` | [键位:446](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L446) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY150 `approval.approve` | [键位:447](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L447) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY151 `approval.approve_for_session` | [键位:448](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L448) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY152 `approval.approve_for_prefix` | [键位:449](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L449) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY153 `approval.deny` | [键位:450](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L450) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY154 `approval.decline` | [键位:451](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L451) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY155 `approval.cancel` | [键位:452](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap/bindings.rs#L452) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用其编辑／导航／菜单键位，不造第二套编辑器 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-KEY156 `global.leader` | [配置前缀:127](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap_setup/actions.rs#L127) | 同屏原生 TUI；在同屏原生 TUI 里用；原生共享前缀设置，不是独立运行时动作 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX01 `fixed.interrupt_or_quit` | [固定键:2513](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2513)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX02 `fixed.quit` | [固定键:2516](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2516)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX03 `fixed.paste_image` | [固定键:2517](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2517)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX04 `fixed.cycle_collaboration_mode` | [固定键:2520](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2520)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX05 `fixed.backtrack` | [固定键:2523](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2523)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX06 `fixed.previous_agent` | [固定键:2524](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2524)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX07 `fixed.next_agent` | [固定键:2525](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2525)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX08 `fixed.slash_command` | [固定键:2526](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2526)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX09 `fixed.shell_command` | [固定键:2527](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2527)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX10 `fixed.file_paths` | [固定键:2528](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2528)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX11 `fixed.connector_mentions` | [固定键:2530](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2530)；main | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX12 `fixed.transcript_edit_previous` | [固定键:2537](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2537)；transcript | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX13 `fixed.transcript_edit_next` | [固定键:2545](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2545)；transcript | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-FIX14 `fixed.transcript_confirm_edit` | [固定键:2549](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2549)；transcript | 同屏原生 TUI；在同屏原生 TUI 里用；原生固定行为，不属于可配置目录 | 归属审计；保留原生分派/配置条件，不再逐行执行验收 |
| C-I01 Text, newline, cursor/word/line editing, undo/kill/yank | `bottom_pane/chat_composer.rs; keymap.rs` | GUI 原样；GUI basic input; native specialized editing 在同屏原生 TUI 里用, preserve native bindings | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-I02 Paste/bracketed paste, burst/large placeholders | `bottom_pane/paste_burst.rs; chat_composer/paste_input.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; native paste semantics/hidden chunks | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-I03 Input history/search, draft recall, Vim/keymap/chords | `keymap.rs; chat_composer/history_search.rs; textarea/vim.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; no second history/editor | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-I04 Queue/edit pending input, prompt stack, steer vs interrupt | `bottom_pane/chat_composer.rs InputResult; keymap.rs` | GUI 原样；GUI exact native steer and interrupt; native queue editing 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-I05 Slash/custom presets, skills, file/app/task mentions | `bottom_pane/slash_commands.rs; mentions_v2/mod.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; native completion/context binding | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-I06 Images local/remote, attachment removal, clipboard/drop | `bottom_pane/chat_composer/attachment_state.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; preserve attachment identity, no text substitute | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-I07 Shell ! and interactive background stdin; external editor | `app_command.rs RunUserShellCommand; keymap.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; no second shell/editor lifecycle | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R01 Streaming user/assistant text, markdown/links, reasoning summary | `chatwidget/protocol.rs; history_cell/messages.rs` | GUI 原样；GUI original text; native layout 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R02 Thinking, request/stream/retry phases, animation/elapsed/tokens | `status_indicator_widget.rs; chatwidget/protocol.rs` | 同屏原生 TUI；在同屏原生 TUI 里用 for exact local spinner/header; do not translate enums into invented labels | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R03 Tool command/output/status/duration/exit, terminal interactions | `history_cell/exec.rs; chatwidget/protocol.rs` | GUI 原样；GUI public native fields, native terminal interaction 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R04 File patches/diffs and apply results | `history_cell/patches.rs; diff_render.rs` | GUI 原样；GUI exact textual changes; native formatting 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R05 Web search/browse/find and progress headings | `history_cell/search.rs` | GUI 原样；GUI native-source formatter and original query/output; detailed native layout 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R06 MCP/dynamic tool result: text/image/content previews | `history_cell/mcp.rs; history_cell/dynamic.rs` | GUI 原样；GUI original public text; non-text preview 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R07 Plan updates/proposed plan/accept or revise | `history_cell/plans.rs; chatwidget/protocol.rs` | GUI 原样；仅 proposed plan 正文；update_plan 步骤进度和接受/修改在同屏原生 TUI 里用，GUI 未投影步骤通知 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R08 Computer/image/media/realtime content and status | `history_cell/computer_activity.rs; app_command.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; no text-only fabricated result | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R09 Native completion time and duration | `history_cell/separators.rs:19,74 FinalMessageSeparator` | 同屏原生 TUI；在同屏原生 TUI 里用；本地排版／时间属于原生 renderer，GUI 不重造时钟 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R10 Recap/Next and recap loading | `history_cell/notices.rs ThreadRecapHistoryCell` | 同屏原生 TUI；在同屏原生 TUI 里用; native generates via own flow, no extra summary model | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-R11 Quota/context/token use, rates/reset/statusline | `status; token_usage.rs; bottom_pane/status_line_setup.rs` | 同屏原生 TUI；GUI public usage scope; full original statusline/reset 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-A01 Exec/patch/network/filesystem approvals, deny/amend/session grant | `bottom_pane/approval_overlay.rs; app_command.rs` | GUI 原样；GUI exact request; native policy actions 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-A02 Questions/options/free text/multi question/skip/native auto-resolution | `bottom_pane/request_user_input/mod.rs` | GUI 原样；GUI exact question/options; native answer controls 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-A03 MCP form/URL elicitation and verification, secrets | `bottom_pane/mcp_server_elicitation.rs; user_verification.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; avoid exporting secret/form semantics | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-A04 Background and subagent approval queue/source navigation | `bottom_pane/pending_thread_approvals.rs; approval_overlay.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; native source routing retained | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-S01 New/resume/fork/cwd context, archive/delete and native session checkout | `chatwidget/slash_dispatch.rs; resume_picker.rs` | GUI 原样；GUI follows verified root context; native session commands 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-S02 Model/effort/service tier/permission settings | `chatwidget/protocol.rs ThreadSettingsUpdated; slash_dispatch.rs` | GUI 原样；GUI effective public fields; native picker 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-S03 Agents/subagents/side conversations and native command center | `multi_agents.rs; chatwidget/slash_dispatch.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; cached child view not a GUI root-identity signal | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-S04 Transcript search/copy/select/bookmarks/raw/follow/resize | `transcript_view; keymap.rs; transcript_mode.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; existing native renderer, no snapshot cameras | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-S05 Configuration/memories/skills/hooks/apps/plugins/theme/pet/keymap | `chatwidget/slash_dispatch.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; preserve native config and feature gates | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-S06 Onboarding/auth/trust/update/IDE/worktree/external app handoff | `onboarding; update_prompt.rs; slash_dispatch.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; OS/native/account-specific actions | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-S07 Errors/retry/reauth/model safety/verification/warnings/reconnect | `chatwidget/protocol.rs; daemon_recovery.rs; backend_banners` | GUI 原样；GUI original public errors; native recovery/menu 在同屏原生 TUI 里用 | GUI 事实按上方任务验收；其他交互保留原生能力 |
| C-S08 Terminal notification/title/accessibility/reduced-motion/voice | `notifications; keymap.rs; screen_reader.rs; voice_strip.rs` | 同屏原生 TUI；在同屏原生 TUI 里用; native/OS surface, physical OS capabilities require actual evidence | GUI 事实按上方任务验收；其他交互保留原生能力 |

以后做·触发条件：当前清单与接入缺口核对后，按完整使用任务逐家族实现、安装版验收和独审；
Codex 完成后再补 Claude 310。当前不新增状态面板、TTY 解析器、前端框架或总结模型。

## 2026-10-23：原生能力核对与 alpha.89 修复

问题：用户看到原生正在工作／等待选择，但对话区缺少相应状态，混用后输入和轨迹不连续。
现有机制：`app/adapters.cjs` 的原生事件、`app/claude-bridge/hooks/register.js`、
`app/native-blocks.cjs` 的消息块，以及同一会话的嵌入式 xterm。
最小增量：修复这些既有路径，观察实际原生连接；不新增答案编辑器、状态面板或模型调用。
不做会坏什么：界面会把等待当执行、把旧上下文当当前会话，或漏掉原生问题和输入。

以下区分对话映射和原生操作，不能把嵌入式终端可用写成全部语义映射完成。
源码按 Codex `rust-v0.163.0` 的
[TUI](https://github.com/openai/codex/tree/rust-v0.163.0/codex-rs/tui/src)、
[协议](https://github.com/openai/codex/tree/rust-v0.163.0/codex-rs/app-server-protocol/src/protocol/v2)
及已安装 Claude 2.1.310 的生成 SDK 核对；没有引入第三方源码或新依赖。

| 原生表面 | 本轮行为与验证边界 |
| --- | --- |
| 正文、公开思考摘要、计划、命令、文件差异、MCP／动态工具 | 既有消息块随原生开始／增量／结束更新；原文可展开。隐藏推理和非文本内容不伪造成普通正文 |
| 完成时间、耗时、usage | 使用原生字段；缺少时保持未知，不拿接收时间或估算速率替代 |
| 发起请求、思考、工具、输出、等待、重试 | 同一输入区的既有状态行更新。Claude 观察心跳过期明确待同步；Codex 重试保持工作而非失败。原生独有 spinner 文案／瞬时 token 读数仍在同屏 TUI |
| 权限、问题与选择 | 对话区保留原生问题／选项和可核的权限正文；复杂／未确认决定在同屏原生终端处理。处理按钮实际申请该视图输入控制，立即输入走既有 ACK 屏障；迟到导航不能抢回焦点 |
| 问答轨迹 | 保留问题和原生终端实际提交的非私密回答；只白名单当前问题 ID 的字符串答案。提交不等于模型采用，`resolved` 只表示请求已处理。正式历史接口实测不返回该工具结果，不能伪称已补齐答案历史。secret 回答不通过通用工具历史旁路显示 |
| Plan／模型／effort | 观察正式 `thread/settings/updated` 的有效字段；不复制 developer instructions。原生 Plan 后 GUI 发出的任务与原生选择已实测一致 |
| `/new`、`/resume`、`/fork` | 跟随该显示连接的实际 RPC 结果，保留历史边界、草稿和原始消息归属；新上下文不承接旧共享授权。失败／存储未确认时禁发，不重试任务 |
| `/model`、`/permissions`、命令菜单、信任与登录 | 保留实际原生交互；已测菜单取消与隔离目录信任，不逐个重造 GUI 菜单 |
| 显示退出／断线、历史恢复与中断 | 退役准确的源连接，已有部分文本没有水位时不拼未知尾部；权威完成可以恢复，已确认中断的私人截断原文保留。共享已撤销后的迟到显示保留在私人会话，不能自动补回共同记录 |
| 原生团队／子 agent 视图 | 保留原生能力，但 TUI 切换已缓存子视图可能不发 RPC；没有当前视图身份的公开证明，不声称对话区已跟随所有子视图 |

Claude 302 保留连接的实际权限路径、当前 310 的阶段路径已验证；未放行未知版本。
系统拼音／微信输入法的物理键盘验证仍与应用内合成输入事件分开记录。
完整 U17 和所有原生瞬时表面的 GUI 语义等价仍未验收。

### Alpha.90：GUI 中断后继续输入

问题：Claude 的 GUI 中断按钮发送 Esc，触发原生的人类 Stop 保护后，GUI 必须回终端才能继续。
现有机制：`Claude.interrupt()`、已有原生显示心跳／私有提交通道，以及已核 310 SDK 的 `$.turn.abort({ turnId })`。
最小增量：用已有心跳回执传递一次明确中断意图，调用原生精确回合 API；不注入编辑按键或另起会话。
不做会坏什么：GUI 的一次中断会让下一条明确输入也被锁住，破坏日用闭环。

仅对已验证的新 2.1.310 连接启用。停止确认同时要求原生 API 返回、对应
`interrupted` 边界、原先 `prompt.submit` 的实际收尾。应用的本地超时／关闭
不等于原生收尾；缺失结果保持未确认，不重发、不转成 Esc。中断不清新草稿，
不重开共享授权，也不宣称整个 fleet 已结束。重复点击复用同一请求；新回合、
接管、上下文／观察连接改变使旧命令失效。原生控制异步执行，不占住观察队列。
中断待确认时，立即限制发送及共享入口，仍允许编辑；跨窗口同步同一状态。
后端在任何控制版本或派发变化前拒绝这段时间的新输入，不自动重放草稿。

真实原生键盘 Esc 和保留的旧后台继续遵循原生暂停语义，不能把本增量描述为
所有 Claude Stop 场景均已无缝。新 GUI 路径已用实际应用／CLI 完成两回合
中断续用，并与 Codex 双流、共享撤销和重载联测；安装版同样通过。

## 2026-10-21：消息块与原生输入语义（部分源码实现，整体未验收）

2026-10-22 状态校正：alpha.81 已有单主阅读区、回复线程、原生排队／追加
输入及逐条投递详情。真人 `@` 和按顺序的有限交接继续保留；新增支持会话可以
通过原生结构化工具明确选择下一位接收者。U21 的这个有限范围已通过原生模型
任务及安装版验证，不扫描普通回答里的 `@`，也不把两种协作模式混为一谈。

最新用户取舍：单人先使用现有嵌入式原生 TUI，完整 1:1 单人对话映射及过程折叠
后置。当前重点是多人共同空间：一个主阅读区，以标明 agent 身份的消息块更新
流式内容；讨论用回复线程区分，点成员筛选轨迹。过滤只是阅读操作。旧的整体
原生映射要求仍是未来方向，不再作为当前共同空间里程碑的前置条件。

下面的问题说明记录早期实现起点，以本段当前状态及测试文档为准。
问题：统一界面漏掉原生过程，工作中输入与中断不自然。
现有机制：已读 `app/workspace.cjs`、`app/adapters.cjs` 和
`app/claude-bridge/hooks/register.js`；GUI 发送仍受 idle 限制，过程与消息分开。
最小增量：把已核实的原生正文、工具和回合事件放进同一阅读区；完整映射仍待验证。
不做会坏什么：把排队当已接收、把发出中断当已停止，导致漏过程或重复投递。

### 一手证据与当前缺口

底层设计也先参考成熟系统，不只参考视觉样式。以下是借鉴范围，不是引入新的
框架或把 provider 原生协议替换掉：

| 设计决定 | 已查来源 | 借鉴及适用边界 |
| --- | --- | --- |
| 记录、接收回执、处理分开 | [Slack Events API](https://docs.slack.dev/apis/events-api/) | 事件身份、重试、确认收到后另行处理；我们的去重与恢复须验证，原生接收未知时不能盲目重发 |
| 回复关联到原消息 | [Slack 线程数据](https://docs.slack.dev/messaging/retrieving-messages/#spotting-threads) | 显式父消息关联；不靠相邻位置推断谁在回答谁，也不照搬 Slack 的时间戳作跨 provider ID |
| 同流呈现正文、工具与状态 | [ACP prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) | 不同原生事件类型驱动内容与工具状态；只借鉴契约，不据此认定 SDK 适配器保留 CLI/Teams 全部能力 |

- [Claude 原生排队说明](https://code.claude.com/docs/en/interactive-mode#when-claude-code-sends-what-you-queued)：
  普通工作中输入可以排队，原生在合适节点接收；`Ctrl+Enter` 的 sendNow 可能
  把工具／子任务转入后台并在同一轮接收，也可能中断当前轮再发送。
  `Esc` 中断还可能接着发送已有队列，不能当作取消全部后续工作。
- [Claude MessageDisplay](https://code.claude.com/docs/en/hooks#messagedisplay)
  提供 `turn_id/message_id/index/final/delta`；同消息的显示 ID 稳定，但不等于
  transcript 的 API 消息 ID。只含 assistant 正文，工具／用户输入另接事件。
  同步 hook 会让原生渲染等它返回。本次以异步有界队列观察该接口，不让原生
  显示等待本地 HTTP；这不等于已经证明所有设备／负载下零延迟。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：`turn/steer` 要求
  `expectedTurnId` 匹配，不另起 `turn/started`；中断请求回执不是最终停止，须看
  对应 `turn/completed` 的实际状态。item 开始、增量、结束提供原生内容边界。
- 已检查的 Claude 2.1.306 生成 Mods 类型有 `turn.start/turn.complete`、`turnId`、
  `agentId`、结束原因；但 `$.prompt.submit` 描述的是等待 idle 后自己的新轮。
  当前应用使用此提交方法，不能直接声称等同原生工作中输入／sendNow。
  这是缓存类型的静态证据，不是其他版本、当前活进程或完整 fleet 的实测。

### 显式回复线程（alpha.57 源码验证）

共享消息上的“回复”进入同一个主阅读区内的讨论；使用显式父消息 ID，
不通过相邻顺序或正文相似度猜归属。流式回复、有限交接的任务和系统事件
保留这个关联。点作者按成员筛选；搜索其他讨论后返回仍保留原草稿的讨论。
讨论父消息被清除时保留草稿并阻止误发；用户可取消回复关联继续。

线程关系只组织阅读。定向发送仅包含当次正文；已有显式有限交接仍会转发
共同任务和上一份已确认回复，实际内容在回执中可核对。线程本身不会额外
附上历史，也没有摘要或路由模型调用。旧后台不支持关联时明确阻止
线程内发送；普通不带线程的原协议调用保持原参数数量。

### 已实现的有限增量与边界

开发源码移除单人／协作中的终端快照、回放滑条和独立过程面板。已核实的原生
正文和工具输入／结果直接在单人主阅读区按稳定身份更新；原生终端仍操作同一
进程。Claude 2.1.307、2.1.308 已用真实 CLI 和本机固定响应验证；后者生成的
完整插件类型除版本注释外与前者相同，仍按明确版本放行，不假定未来版本兼容。

实际 CLI 证明 `MessageDisplay.turn_id` 与 Mods `turnId` 并非同一命名空间。
记录保留两者，通过原生 `prompt_id` 与 `turn.start` 的对应关系建立关联；
缺失或歧义时保持未确认，不以正文相似或到达时间猜归属。块结束、回合结束、
后台工具和子 agent 结束分别处理。工具记录沿用有界缓存；alpha.77 起已显示的结构化工具输入和结果随本地记录保存，未结构化的终端观察仍仅在内存中；
超限、断线或丢事件明确显示缺口／未知，不能宣称可完整回放。

现有获准共享的最终回复必须同时匹配原生接收凭据、回合和完整显示正文。
`Stop.last_assistant_message` 不得绕过显示变换，把原本隐藏的文字分享到房间。
原生最终答案的尾随空白规范化仅用于完整性核验，实际显示正文不改写。观察缺口
撤销共享证明；不能用旧证明继续交接。此检查不新增模型调用。

旧活后台保留原有身份，已有过程记录降级为同一阅读区内的“旧连接记录”，
不伪造其与保存回复的全局顺序。断线保留最后记录，重接后重新获取；连接未知时
不把旧的 running 当成当前状态。alpha.56 安装版对已接通的旧 Codex 复用同一原生
历史／增量／工具映射；重接失败保留禁发的已知内容，成功后才替换。安装后的旧会话与共享流界面验收通过；真实旧 Codex 的 8 条历史已回到主阅读区。

获准共享的原生回合可在共同阅读区流式更新正文和工具块，块保留 agent、turn、
来源消息关联。离开、权限等待、接管、缺口或暂停关闭后续共享；模型收到的精确
内容仍由原消息的投递详情展示。过程可见本身不额外派发任何模型请求。

**后续增量：**回复线程已在 alpha.57 验证；已知 Codex 回合的单人追加指令在
alpha.58 验证；Claude 2.1.308 单人等待输入在 alpha.59 验证，协作等待输入在
alpha.60 验证。工作中 Codex 协作追加指令在 alpha.61 经源码、实际 CLI 与安装版验证：
原生 ACK 与精确输入回显共同确认后，仅新开始且归属明确的消息块可共享；迟到的旧块
不改归属，未知起点不提升，原生错误撤销后续共享。仍使用同一模型上下文，新的回答
可能引用已有内容；不宣称上下文隔离。**仍未完成：**Claude 强制发送、
原生输入回显与所有临时菜单／权限状态的一一对应，以及保留旧后台的全面兼容性。当前测试不证明 U17 完成，也不证明原生所有瞬时变化均已映射。

### 消息块的约束

对应竞品复查（2026-10-21，仅定点源码检查，未运行竞品）：

| 产品及已读版本 | 与当前需求的重合 | 对本项目的决定 |
| --- | --- | --- |
| Orca `5c5f9a2` | [同终端 Chat UI](https://github.com/stablyai/orca/blob/5c5f9a23629192451a6ee12262134993a336d7e8/docs/site/content/docs/agents/native-chat.mdx)；[流式文本归同一消息行](https://github.com/stablyai/orca/blob/5c5f9a23629192451a6ee12262134993a336d7e8/src/main/native-chat/agent-session-timeline/provider-timeline-text-streams.ts)；已读队列发送入口 | 优先研究其事件身份、块映射和队列机制；官方仍标实验性，未证明全部瞬时终端状态保真。停止后丢弃尾部的策略须核原生确认后再决定，不能照搬 |
| Codewhale `585ca22` | [终端／网页控制桥](https://github.com/codewhale-hq/Codewhale/blob/585ca22b6fb4cd3cc31cb0feaa1582a2fa1496a8/crates/tui/src/tui/ui/remote_control_bridge.rs) 区分派发和回执；[Runtime API](https://github.com/codewhale-hq/Codewhale/blob/585ca22b6fb4cd3cc31cb0feaa1582a2fa1496a8/crates/tui/src/runtime_api.rs) 有 steer 路由 | 借鉴双入口控制和状态边界；这是其自身 runtime，不能据此宣称可直接接管外部 Claude/Codex CLI |
| Nimbalyst `e14ddf3` | [TeammateManager](https://github.com/nimbalyst/nimbalyst/blob/e14ddf383a8dbb40e511fc2c2ea50273d08e3579/packages/runtime/src/ai/server/providers/TeammateManager.ts) 提供队列、streamInput、消息路由 | 可参考消息投递；已读 Task+team_name+name 分支会拦截创建并托管 teammate，不能把该路径直接当作保留原生 Teams 的方案 |

这几项已存在明显重合，不能声称无人做过；也没有证据证明某一竞品完整满足
本产品所有要求。本轮没有复制代码或新增依赖。后续先比较适配成本与自研成本，
再选复用范围；逐文件及依赖许可检查不能只靠仓库首页的许可证标签。

1. 块关联原生 session、agent、turn 与 message/item 身份；缺失身份不能靠文本
   相似、屏幕行数或时间猜测去重。一个 turn 可以含多条消息和多个工具块。
2. 原文增量更新所属块，保留原生顺序和原生最终内容；线程回复只建立关联，
   不复制历史。跨 agent 没有天然全局时钟，用接收顺序并保留因果关联。
3. 用户提交可先呈现“待接收”；只在原生证据支持时推进状态。请求中断不立刻
   冻结内容；允许原生截止前的尾部增量归回原块，确认后保留被截断的原文。
   没有可靠确认时显示未知／待确认，不能静默重发。
4. 插入新指令不必终止原消息所属 turn；转入后台的工具／子任务继续显示真实
   状态。主轮结束、文字块结束和整个 fleet 结束是不同事件。
5. 完整映射包括工作过程、权限、错误、排队／输入回显与工具状态；仅最终正文
   或一个显示 hook 不满足 1:1。用户未提交草稿仍是草稿，不能伪造为已发消息。

### 投递规则：已确认与待讨论分开

最新确认：真人已提交的消息必须保留在消息列表，不能因为接收结果未知而消失。
共享可见与实际送入某个原生 agent 的区别需要就地可辨识。当前开发版在消息内
使用原生 HTML details/summary 展开接收者、等待／已接收／未确认状态和本次
发送全文；自动交接的任务背景及包装文字同样可查。不增加模型调用，不把此
正文误称为模型的完整上下文（原生历史、系统指令、hooks 仍属 provider）。
后续暂停或脱出只撤销继续分享，不抹掉先前接收凭据。重启后缺失 ACK 保持
未确认，不自动重试。旧记录没有完整凭据时明确未知。成员筛选包含发送给该
成员的交接源消息。此增量不决定真人无 @ 时的默认路由，也不实现自动广播。

- 已确认：真人在协作消息中明确 @ 谁，只投递给对应 agent；agent 明确 @ 另一
  agent 是定向协作，不带 @ 的 agent 消息给真人。轻量模型自动路由后置。
- 当前实现：真人的 `@` 选择绑定稳定会话 ID。agent 使用带准确接收者 ID 和正文的
  原生工具登记一次交接；引用、代码、邮件地址、工具输出和原生 `@文件` 不触发路由。
  当前模式等本原生回合正常结束，再复核成员、权限、原生身份和上限并投递一次。
  没有定向调用则本次回复给真人并结束协作；并未实现工作中任意时点的互相打断。
  单条工具登记或投递 ACK 都不能被当成原生回合结束或对方已经处理。

U21 已复用 Claude 原生 MCP/Mods 执行链、Codex App Server dynamic tools 及
既有共享授权/回执，原生权限继续生效。实际验证版本包含 Claude 2.1.309/310 和 Codex
0.163.0/0.164.0，后者须是工具已注册的 GUI 新建会话。保留服务及 terminal-first 会话没有
经验证的工具热注入，不会为接入静默重启或复制；仍可用其原有手动或顺序交接。
工具说明、成员表、工具后的模型继续生成计入原生用量，没有额外路由模型不等于
零额外 token。真实模型任务、原生拒绝、暂停和重开证据见 [testing.md](testing.md)。

参考：[Claude Mods API](https://code.claude.com/docs/en/plugins/mods/api)、
[Codex App Server](https://learn.chatgpt.com/docs/app-server)。
已核的 [Cotal 定向工具实现](https://github.com/Cotal-AI/Cotal/blob/7cdd209c3591eac510c057f2ee720a5af1fd6ae7/extensions/connector-core/src/tool-specs.ts)
用结构化 DM 参数及独立回执，可借鉴这些边界；它的 channel mention 仍向频道
全员投递，不符合本产品 `@` 只发给指定会话的规则，不能直接照搬。
这项参考未运行竞品或复制其代码；实现复用已有 DeepSeek SDK 的 MIT JSON-RPC
传输，精确版本和分发声明见 THIRD_PARTY_NOTICES.md。
- 待确认：真人无 @ 时的行为。建议回复已有线程时继承其明确接收者；房间根
  消息无接收者先留记录，界面清楚显示尚未发送给 agent。不能默认为广播。
- 同一阅读区可呈现共享消息，但不把私人 TUI 历史或轨迹自动公开。共享记录
  可查看、已投递和模型已处理不能混称“已读”；自动塞给所有模型会增加上下文
  与潜在成本。未来按需读取也要保留权限和原生用量边界。

### 实现前的最小验证范围

只围绕同一条“工作中真人纠偏、随后定向交给另一 agent”流程，核对普通排队、
安全点接收、sendNow 的后台化／中断分支、强制中断、原生与 GUI 双入口、迟到
增量、一次投递、私人数据边界。先验证可观察的原生事件和版本能力，再接 UI。
复用已有本地证据；确需原生推理时使用明确限额的低成本测试，不重复刷用例。
没有这些证据前，U17 保持开放，不宣称完整映射或新协作路由已交付。

## Alpha.16：同一会话里的合作与独立工作

Alpha.17 根据侧栏反馈进一步区分“会话”和“协作空间”：各有分组标题、条目缩进和
分隔线，底部工具另成一区。中间是单一滚动区，窄侧栏隐藏文字后仍保留分隔线。
“会话”包括协作中的成员，保留状态提示，避免把仍参与协作的会话误标为独立。
工作区归档后显示恢复入口的说明，不留下含义不明的空分区。这里借鉴用户提供的
VS Code 截图中的层级关系，不引入文件树、重复成员节点或新的会话对象。

侧栏的会话、工作区用紧凑行显示；名称旁的 ⋯ 与右键菜单提供重命名、加入／
脱出、归档等动作。工作区可以改名。拖入工作区加入，拖回“会话”区脱出；
拖动期间只显示落点提示，不改变布局、不另建会话、不通知模型。

共享记录以时间线呈现消息及确认后的成员变化，可搜索、按成员筛选、复制筛选
结果，再回到消息上下文。筛选只影响阅读，不改变发送对象；私人会话与原生工具
轨迹不自动混入时间线。当前不是完整的跨 provider 工具执行审计视图。

输入 @ 或点 @ 选择一个接收者；同名会话显示 provider 和短 ID 以便分辨，内部
绑定稳定 ID。选择结果在“发给”处持续可见。粘贴的 @ 文本不自动路由，也没有
隐式群发。Enter 发送、Shift+Enter 换行；候选列表打开时 Enter 只选择成员。
自动一轮核查放在输入区 ⋯，运行期间暂停仍直接可见。

“共享笔记”保存共同目标、决定与待办，其版本留在本地时间线。加入／离开事件
不是模型已经读到的上下文。用“附上背景…”可预览、编辑并加入共享草稿，只有
明确发送才进入选中 agent 的原生上下文。独立会话可查看笔记、复制背景到原生
输入；不会在另一个窗口接管后自动改写它的草稿。已发送资料不因脱出而撤回。

会话 ⋯ → 归档会话；工作区 ⋯ → 归档工作区。侧栏“归档”统一找回，保留名称、
记录、笔记及原会话 ID，显示仍在工作的原生状态。会话归档先脱出，工作区归档
先暂停交接。恢复工作区找回原成员，跳过已单独归档的会话；恢复会话先回到独立
使用。归档不终止原生任务，恢复不重发旧任务，原生进程丢失时仍需显式恢复历史。
当前只有一个工作区；归档后创建多个新工作区属于后续能力。

这些交互借鉴了 [Slack 的明确提及](https://slack.com/help/articles/205240127-Use-mentions-in-Slack)、
[Discord 的名称消歧](https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names)
和 [Zulip 的消息检索](https://zulip.com/help/search-for-messages)，未复制其代码或素材。
我们的单接收者及不自动广播背景是本产品的隐私／成本取舍，不是这些产品的统一规则。

## 默认只呈现当前工作

侧栏有独立会话和协作空间；主区域默认显示当前一个会话。目录、附件、成果按需打开，不要求先创建项目。多个窗口是同一份会话的不同视图，不是另一份 agent。

会话的管理操作放在会话行旁的「⋯」菜单，右键打开同一菜单；不为每个低频动作
增加常驻按钮。菜单提供重命名和在独立窗口打开。操作未选中的会话不应切换当前
工作或接管其输入；重命名只改本机显示名。鼠标、Tab、Enter、方向键都可使用，
Escape 或点击外部关闭，Tab 离开时不执行动作。状态刷新不能移除当前菜单的焦点。

### 现有界面的减负审查

以下是根据实际界面与源码的设计判断，不是统计出的使用频率。本轮只调整会话
操作入口；不增设设置中心、侧栏或快捷键体系。其余项按触发条件处理。

| 入口 | 判断与处理 | 状态 / 触发条件 |
| --- | --- | --- |
| 标题旁的重命名、独立窗口 | 都属于会话本身，合并到侧栏同一菜单 | 本轮实现，实测与审查见 review.md U09 |
| 没有选中文字时的“分享选中内容” | 空操作只给提示；宜由有效选区决定是否可用，区分整条消息分享 | 以后做：下次调整分享路径时处理 |
| 安装与版本检查 | 首次使用/依赖缺失时必要，日常就绪状态可弱化常驻入口 | 以后做：调整首次使用或侧栏时处理 |
| 自动核查的主按钮 | 默认定向发送；自动核查单独触发，保留未知 fleet 暂停保护 | alpha.13 已完成，见 [审查与验收](review.md) U09-F3 / A13-1 |
| 发送、权限确认、中断、暂停、GUI/TUI 切换 | 决定当前工作与真人控制，保持直接可见 | 不为视觉简化收进通用更多菜单 |
| 终端复制/粘贴、隐私与用量 | 对应明确用户反馈，仍需容易找到；显示设置已限于终端视图 | 保留；有实际使用阻塞再调整 |

```text
会话 / 协作             当前会话 · Claude             [对话 | 终端] [更多]
  我的笔记
  Codex 核查             对话与当前成果
  学习材料（协作）
                        输入……                            [发送]
```

邀请现有会话以后，空间提供“协作记录”与各参与会话的入口；不自动将窗口拆成许多小格。用户可以选择并排、标签页或独立窗口，系统记住偏好。

```text
学习材料 · 协作                         [暂停协作] [成员与共享]
[协作记录] [Claude] [Codex]             [成果]

实际交接的内容、可追溯的结果、待人决定的问题

发给：[Claude ▼]  输入……                [发送]
```

协作记录是已发生事件的视图，不默认调用模型总结各方完整对话。选择一个 agent 的视图时可以查看其私人会话；这不意味着其他 agent 可以读取。

## 加入现有会话

1. 拖动侧栏会话到协作空间；“加入协作…”菜单和键盘可访问的选择器提供相同动作。
2. 展示具体参与者与本次共享范围。第一次邀请默认只分享用户选择的材料、问题或消息，不自动分享整段历史；既有适用授权可复用。
3. 建立成员关系，原生 session ID、进程、fleet、待回答问题保持不变。忙碌的会话仍忙碌，不能为了加入先偷偷重启。
4. 只有显式发送或已授权协作规则才开始向新成员交接。拖动本身不调用模型。

“把窗口拖出来”和“退出协作”必须有不同落点及菜单语义。前者只换视图；后者改变成员关系。

## 脱出继续工作

退出时立刻冻结该成员的后续房间路由、撤销尚未发送的交接，保留原生会话。默认在独立视图继续当前工作；退出不等于杀掉原生任务或撤销已经发生的文件操作。

如果交接正在传输，显示“正在完成退出 / 有一条交接状态待确认”。不能把无法确认的发送标成未发生，也不能自动重试可能已经接收的输入。后来的房间回复保留在房间，不继续投递给已退出会话。

房间的自动任务在缺少必要参与者时等待，不能擅自另建一个替身。重新加入时，展示离开期间可选择的交接材料；不自动重播整段协作。

需要明确告诉用户：退出不会让其他 agent 忘记已收到的资料，也不会自动收回原生工具已有的磁盘访问权。真正停工是另一个明确动作。

## 接入应用之外的会话

| 外部状态 | 可以承诺的动作 |
| --- | --- |
| 已由本应用本机进程服务托管 | 移动成员关系或新增视图；不另起 runtime |
| 上游正式支持实时 attach，且能安全协调写入 | 连接现有 session；通过版本化验证后开放 |
| 已停止，原生支持 resume | 恢复原 session 历史；明确标注恢复，不能声称保持旧进程或活跃 fleet |
| 正在其他终端运行且没有安全 attach | 说明暂不支持实时接管；可关联只读资料或引导停止后恢复 |
| 只有聊天导出文件 | 导入为参考资料，不伪装成同一原生 agent |

不扫描和接管所有 iTerm2 窗口，不把并行 `resume` 当作安全 attach。外部连接必须是用户选定的会话。

## 人介入和离开

直接发给某个 agent 的消息，只进入指定会话。如果它正在为房间执行任务，先明确是否需要打断当前任务，不能混入第二个竞争写入者。

“暂停协作 / 接管”先阻止新交接、取消旧队列，再向受影响 runtime 请求中断。界面区分正在停止、已停、仍有原生子任务。已经发生的外部操作不因停止而回滚。

用户说“我要睡觉了，你们把事情做完”时，将当前任务转成一个有完成条件和授权范围的自动协作运行，简洁展示参与者、交接上限和何时等人。遇到新权限不擅自批准。电脑实际休眠会暂停本地执行；申请保持唤醒需要单独可见的选项。

默认核查只进行一次。持续协作不靠两个 agent 相互寒暄：交接围绕具体成果、疑点、修改与完成条件；没有新成果、达到上限或反复失败就停。

## 键鼠与可访问性验收

所有拖动都提供菜单/选择器等价动作；焦点、Tab 顺序、读屏名称明确。中文输入法组合期间不误发 Enter；支持复制、粘贴、附件、选择文本、缩放、滚动回看。原生终端的输入与选择行为需要按实际 provider 验证。

切换 GUI/TUI 不清空草稿，不重新发送未确认输入；多个视图显示一致的 busy、等待授权和停止状态。默认界面不展示 PID、协议名称、预算计量缺口等实现细节；只有影响当前决定时以人话说明。

## 统一体验验收与反馈依据

本轮研究服务于整个 Desktop + TUI 产品，覆盖 Codewhale、Orca、Nimbalyst、Claude/Codex 与其他工作台的公开用户反馈，并对照本仓库实际源码。下表是任务验收标准，不是同时开工的功能清单。公开 issue 是自选样本，不能推导发生率；关闭可能表示修复、重复、过期或部分解决。未对竞品进行本机复现。

| 用户要完成的事 | 统一产品的验收条件 | 当前边界 |
| --- | --- | --- |
| 输入、改稿、换入口继续 | 原文、附件和接收者一致；未提交内容不被后台交接带走；中文选字、粘贴不误发 | 图形草稿有保存；Claude 2.1.302 已实测阻挡有草稿的外部发送，见下述范围；物理 IME 待验 |
| 读长答案并交给另一会话 | 可读、可选择、可复制；发送选定内容时保留来源和完整文本；滚动审阅不被更新抢走 | 复用现有消息/分享入口；长时阅读与跨视图完整性待验，不能只验证屏幕上有字 |
| 判断现在该等还是该介入 | 谁在做什么、谁等人、信息何时更新；能到同一原生会话核对；不靠模型轮询解释状态 | 原生实时视图已有；全部 fleet 状态和通知一致性未证明 |
| 授权、纠偏、暂停、恢复 | 能看全实际授权对象；区分待发送、已送达、已接受；拒绝与执行后中断分开，暂停不假称撤销副作用 | 现有 owner/revision 防旧队列继续；有效权限保真与活跃 fleet 停止仍有缺口 |
| 找回同一份工作 | 重新打开、加入/脱出协作不制造替身；找到原有历史、草稿和工作目录 | 已验部分应用内连续性；外部活会话接入与冷恢复不可等同 live attach |
| 核对成果和代价 | 能打开当前真实产出；知道什么被分享、什么留在本地；费用来源/范围/缺失清楚 | 原生凭据及显式共享边界已有设计；完整网络审计、同条件成本对照与完整产物体验待验 |

几条直接影响这些标准的证据：

- Orca 用户用 GUI 阅读长文和图表，用原生终端核对卡住状态及执行 rewind；也有反对意见认为热切换不能牺牲 GUI 稳定性。切换入口恢复后问题已关闭，不能当作当前缺陷。我们采纳的是两种入口各自有用且工作连续的要求。[Orca #17883](https://github.com/stablyai/orca/issues/17883)、[反对意见 #17424](https://github.com/stablyai/orca/issues/17424)
- Orca 协作通知混入未提交草稿的多次报告说明，输入静默几秒不代表编辑框为空。Codewhale 的多行粘贴报告则提醒，修复声明仍需要实际终端环境复测。[Orca #11242](https://github.com/stablyai/orca/issues/11242)、[Codewhale #6986](https://github.com/codewhale-hq/Codewhale/issues/6986)
- Claude 跨端恢复已有部分改善，旧 lineage ID 和新鲜会话竞态仍有用户报告；Superset 升级后恢复部分列表也不等于分组完整恢复。应验工作身份及用户组织方式，不能只验有窗口。[Claude #80773](https://github.com/anthropics/claude-code/issues/80773)、[Superset #5537](https://github.com/superset-sh/superset/issues/5537)
- 原生权限的隐式变化会破坏信任。cmux 的争议是偷偷加入允许绕过的参数，不等于默认已进入 bypass；Codex 的报告则涉及显示权限与实际 policy 不一致。我们必须核对生效配置，不能只保留一个相似标签。[cmux #3547](https://github.com/manaflow-ai/cmux/issues/3547)、[Codex #32338](https://github.com/openai/codex/issues/32338)
- 用户喜欢 Nimbalyst 仍因无法解释额度消耗而放弃日用，但其精确费用倍率没有同条件证据。Codewhale 的用量反馈也区分已测主任务、子任务与未知项。我们的纯查看/切换操作必须无额外模型请求，完整成本对比另验。[Nimbalyst #889](https://github.com/nimbalyst/nimbalyst/issues/889)、[Codewhale #6011](https://github.com/codewhale-hq/Codewhale/issues/6011)
- 非代码任务同样需要找到文件成果；用户不应为了开始一个任务先学 Git/worktree。优先复用当前会话和文件打开方式，具体预览需求出现后再扩展。[Codex #40663](https://github.com/openai/codex/issues/40663)、[Superset #5960](https://github.com/superset-sh/superset/issues/5960)

### 当前首要断点

Alpha.4 的 Claude 外部发送会向原生编辑框粘贴后按 Enter，没有证明已有草稿为空。
Alpha.5 已改为 Claude 原生 Mods 的 `prompt.read` / `prompt.submit`，通过私有本机
socket 获取明确文本与当前控制授权，不写原生编辑框，也不复制整个会话上下文。
同一 `Workspace.send` 边界覆盖单独对话、定向分享与自动交接。

实测范围：Claude Code 2.1.302 的真实应用窗口中，原生合成草稿阻挡图形发送及
定向分享，两边草稿保留；清空草稿后，显式文本原样进入原生历史，回复和发送状态
在图形界面一致。切换到终端后第一下按键丢失的竞态也已修正并复测。
本地检查覆盖交接、脱出、接管、中断、授权超时及迟到回执；不把模拟取消当作
原生运行中撤销或 fleet 停止的证明。见 [测试细节](alpha.md#structured-claude-submission)。

授权检查是派发边界，之前的真人操作使请求失效；之后已交给原生的工作需明确
中断。当前接口不提供跨原生队列的原子撤销承诺。原生未确认时保留草稿，不重发。
旧后台和未连接安全接口的 Claude 会话仍可用原生终端，图形发送会被明确限制。

这些合成用例未发现草稿夹带、丢失或自动重发。Codex 原生草稿、物理 IME、附件、
其他原生插件改写提示及完整并发队列仍需分别验收，不能借 Claude 文本用例宣称通过。
禁止盲目清空编辑框、空闲计时或复制 session 冒充保护。

此前发现的权限覆盖和未知任务数零兜底已分别在 alpha.7 / alpha.6 修正：不再强设 Claude 权限模式或 Codex sandbox/approval，缺失 background/scheduled 保留未知并阻止自动交接。仍有边界：Claude teammate 模式固定为 in-process，并带有显式流量与提示建议选项；完整原生配置保真及活跃 fleet 停止没有验收通过。不能把已修正的问题继续当作当前缺陷，也不能把局部修复称为全部原生功能等价。

以后做·触发条件：本轮发送边界之后，沿同一完整任务验证有效权限、未知 fleet 状态及待人动作；在有干净系统空间后验证下载到首次使用；日用遇到阅读、产物或焦点阻塞时改善现有视图。完整网络与成本对照、物理 IME/读屏和活跃 fleet 仍是对外扩大试用的验收项。此处没有新增调度器、账户体系或常驻仪表盘。

## 2026-10-23：Codex 可读性与输入框内 @

本轮先处理 Codex，不扩写 Claude 原生状态适配。紧凑消息仍保留作者、正文、
复制／分享和原生工具原文。借鉴 [Slack 的紧凑消息模式](https://slack.com/help/articles/213893898-Change-how-messages-are-displayed)
与 [Discord compact 模式](https://support.discord.com/hc/en-us/articles/217047657-How-do-I-switch-to-compact-text-mode)
减少行间空白，不引入新的监控面板。

房间仍是一个明确接收方。选择后的 `@名称` 留在原有 textarea 中；保留系统
输入、选区和撤销，不引入独立富文本编辑器或影子输入层。名称有重名时显示
短 ID。可信的 ID、范围和成员版本与草稿一起保存；普通手写／粘贴 @ 不匹配
路由。仅选中的确切地址范围从发送正文中排除，详情继续显示真实发送内容。
发送后保留可见的 @ 地址，正文清空；迟到确认不能清掉更新或已失效的草稿。

改名、离开或成员版本变化使地址失效，正文和旧地址文本保留，但发送关闭。
旧范围仅供重新选人时替换，不能重新取得发送权限；用户编辑该范围后，它也
不再作为旧地址删除。读屏只播阶段变化，秒级计时不持续播报。

Codex 活动来自 [官方 app-server 的 turn/item/status 事件](https://learn.chatgpt.com/docs/app-server)，
并绑定原生 thread/turn。时间来自原生 Turn.startedAt；未知时不显示计时。
并发工具完成一项不等于全部结束。没有证明协议暴露 spinner 原句、逐 token
实时计数或纯思考时长，因此本轮不模拟这些读数。完整 TUI 1:1 映射仍未验收。
