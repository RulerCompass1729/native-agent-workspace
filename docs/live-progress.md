# 原生实时显示与运行轨迹

2026-10-19。alpha.24 新后台已实现下述有界 TUI 观察能力；本地协议/界面回归与真实原生任务已验证。随后用户旧会话截图暴露未覆盖路径，U17 重新打开；新后台的通过结果不等于原有会话无缝切换已完成。审查记录见 `review.md`。这不是原生 Desktop 适配或永久完整轨迹归档。

实际试用纠正：图形对话不是只保留最终回答的摘要。原生可见的工具执行、等待确认、错误、耗时和结果可以组织、折叠，但应能在同一会话中查看；不能凭整理界面而省略。终端与图形输入应服务同一原生会话，切换不丢草稿、不误投、不自动重发。现有旧后台的发送保护不是目标体验；保留保护的同时必须解决接入缺口，再按原会话验收。旧 Claude 的 snapshot 只读现有终端，可评估兼容接入；旧 Codex 的同名接口有创建分支，不能泛用。接入前已覆盖的临时画面及未广播的尺寸事件不能补造。

问题：用户在统一界面发送后看不到原生 TUI 的临时状态、中间结果和滚动过程；
单会话与协作的轨迹都不完整。用户进一步要求 TUI 可见内容一一对应，仅允许很小延迟，
后续接入原生 Desktop 时也同步其可用的界面状态。
现有机制：`adapters.cjs` 的原生事件与 PTY、`workspace.cjs` 的会话状态、
`daemon.cjs` 的终端广播、`renderer.js` 的对话/终端、现有时间轴和成员筛选。
最小增量：一套每会话的实时观察与轨迹能力，由单聊和协作复用。
不做会坏什么：用户无法判断等待、授权、失败或完成，中间成果被后续状态覆盖。

本次决定是如何补齐可观察性，不替换 DSH、原生 runtime 或协作调度。
源码审查和合成事件复现不调用模型；后续实施先用本地输出夹具，再只验证必要的原生差异。
关键读数为内容对应、观察副作用、显示延迟、身份/派发保持以及本地资源占用。

## 实施前确认的缺口（保留问题来源）

| 链路 | 实际实现 | 缺口 |
| --- | --- | --- |
| Claude | hooks 转发工具名、状态和最终 Stop；PTY 保有实际屏幕输出 | 对话没有中间正文与工具完成结果；hook 白名单也没有完整工具输入/输出 |
| Codex | 已处理正文 delta；工具开始只留下类型，完成主要处理 user/agent message | 工具输出、结束状态、耗时和其他进展未形成运行记录 |
| 会话状态 | `activity` 被下一次活动覆盖，完成时清空；fleet 有截断 | 不是可以定位和回看的 trajectory |
| 协作界面 | 共享时间线与单个成员终端互斥显示 | 看共享讨论时不能同时了解各成员正在做什么 |
| 终端观察 | 快照接口调用 `openTerminal()`；成员视图可改 view/claim | 自动展示多个成员不能直接复用交互入口，否则观察可能创建连接或改变控制 |

合成事件复现确认：Codex 命令开始、输出增量、完成三个输入只产生工具类型活动；
Claude 工具开始/结束输入只产生工具名与 working 状态。此为源码级证据，非新原生任务。
前一次短任务证明了提交、交接、隔离与恢复，不能覆盖这项实时完整性。

## 一个来源，两种呈现

**原生可见内容是基准，整理后的轨迹是索引。** 原生已经显示的临时文字、输出、
审批、错误、流式回复、清屏和重绘不能只剩一个“正在工作”。不调用模型解释屏幕，
不猜进度，不将未公开内容或缺失事件编成推理轨迹。

- **原生实时视图**：同一会话已经存在的原生终端输出，按顺序和原生尺寸解释。
  保存正常/备用屏幕、光标、样式、换行和重绘语义，不能把 ANSI 简单去掉当聊天文字。
  正常连接、声明负载与保留窗口内不丢输出字节；受屏幕刷新率限制可以合帧。
  短暂出现后被覆盖的内容可从已保留记录回看。溢出或断线明确标记缺口并重对齐屏幕，
  不同时承诺有界资源、永不阻塞与无限完整。
- **运行轨迹**：将明确的原生开始/结束、工具、审批、失败、产物和回复关联到来源。
  有稳定 turn/item ID 就使用；没有就保留观察顺序与来源，不伪造关联。
  有可靠关联时跳到相应原生记录；否则只定位该会话/时间段并标明范围。
  不能只有最终消息，也不把 spinner 每一帧都变成聊天行。

同一数据不被复制成另一个 agent 的上下文。按会话、任务和时间筛选只改变真人视图。
入房、脱出、归档不改变轨迹的 session 身份；共享时间线保留实际发送/接收的引用与授权范围。

## 界面行为

单会话在现有对话内显示当前运行过程，允许展开完整原生实时视图及本次轨迹。
查看旧内容时保持阅读位置，新输出有明确提示；最终回复出现后过程仍可展开回看。

合作页同时显示两位成员的实时状态和各自输出区域，允许并排或窄窗上下排列，
每位成员独立滚动、展开和查看历史。复用同一会话组件，保留共享讨论及现有成员筛选，
不增加独立“监控中心”或另一套任务管理。

默认观察不夺取输入焦点。只有明确操作某位 agent 时才进入其原生控制通道；
其他成员继续实时显示。所有成员轨迹是**给真人查看的私人详情**，不自动写入
“共享记录”，也不随下一条提示词发送。选择共享依然需要明确的接收方与内容。

## 实现边界

1. 在现有 session 服务中增加真正只读的输出订阅：只读取已存在的终端，
   不调用 `openTerminal`、claim、input、resize、native resume 或模型。
   输出及尺寸变化携带会话、连接代次、序号和时间；快照接续必须去重并识别缺口。
   未打开终端、旧后台或断线时显示实际能力，不自动启动第二个运行实例来补画面。
2. 原生屏幕只有一个权威尺寸和设备查询应答者。只读面板按该尺寸显示或滚动，
   不因面板大小变化反复修改原生终端；明确接管后仍沿用现有单输入者规则。
3. 在输出链路旁增加有界的本地内存观察记录与检查点，并接入已经收到的结构化事件。
   输出接收与原生输入路径独立；不把大量终端增量塞进每次完整 workspace 快照。
   断线缺口、缓冲上限或磁盘失败必须可见，不能静默截断后声称完整。
4. 历史优先引用原生记录；临时显示默认只在服务的有界内存中保留。
   完整终端可能包含未提交草稿、登录信息、密钥或私人路径；不能依赖自动脱敏保证安全。
   若后续需要落盘，必须先明确新增数据范围、最小权限、容量/期限、清除和用户披露，
   不在本次方案中默默开启。结构化持久轨迹也须逐字段限定，不能直接存全量协议载荷。
   原始观察记录默认不进入导出、共享、诊断或上传；不记录其他应用屏幕或所有原生历史。
   清除观察记录、清除共享记录与删除原生历史是不同操作，不混淆。
5. 观察记录不参与“是否已完成/允许交接”的安全判断。看到一行输出、进程活着、
   最近有数据，都不能替代原生确认，也不证明全部后代已结束。

零额外模型调用是硬要求；本地绘制、缓存、存储不是零开销，需要实测和约束。
先采用事件驱动转发；暂定正常负载下壳层接收到可见绘制的 P95 不超过 100 ms，
双会话突发输出场景不超过 200 ms。这是声明负载下的验收目标；本轮双路合成小块输出实测见下文，
也不把原生模型/工具尚未输出的等待算成同步延迟。

## 同一原则延伸到原生 Desktop

会话、身份、轨迹、控制权与来源视图分开：TUI 输出由终端适配器提供；
未来原生 Desktop 状态由该客户端实际支持的接入方式提供。共用订阅、
来源标识、时序、能力缺口与轨迹索引，不假定桌面界面也是文本终端。

CLI 会话相同不证明官方 Desktop 已接入；原生桌面内部界面状态未必全部公开。
未核实受支持接口、权限、会话映射与条款前不承诺一一同步，也不以另开模型会话
或静默抓取其他应用屏幕冒充同步。本次先补 TUI 来源的完整实时可见性；
Desktop 适配在确定具体客户端与接入能力时实施。

## 验收门

- 以合成终端输出覆盖 Unicode、长行、重绘、备用屏幕、清屏、短暂结果、审批和错误；
  在同一序号/尺寸检查原生权威屏幕与观察屏幕，未实现映射的内容仍能从原生视图看到。
- 单会话和两个成员同时更新；可回看并按成员定位，跨会话不串内容。
  阅览、复制和展开不改变 owner/view/controlRevision、run、原生身份或提交数。
- 重开和断线恢复不重复输出、不重发任务；缺失的旧临时输出明确标记，不能倒造。
- 阻塞、等待授权和错误及时可见；更新不抢焦点、滚动位置、中文输入或选择范围。
- 测量显示延迟、CPU/内存/磁盘与队列增长；高吞吐时有界且不阻塞原生工作。
  保持旧后台能力降级和同会话原生核对入口。
- 用真实可见产品验证一个含工具/中间输出/等待的有限任务；不再用纯最终 JSON
  短任务替代此项，优先复用协议回放，必要原生测试先定最便宜适用模型和提交上限。

只有这些检查与独立审查通过，才关闭实时可观察性的缺口。

## alpha.24 实现与验收范围

`observation.cjs` 提供按序原生字节/尺寸日志和结构化原生工具记录；
`NativeProgressPanel` 由单聊和共享页复用。只读面板不启动终端、不回应设备查询，
不 claim、不 resize、不发送或恢复原生会话。原生主屏与观察屏按同样的尺寸处理 ANSI。

每会话原生事件上限为 1,200 条或 2 MiB 序列化 UTF-8 数据；检查点上限 4 MiB。
结构化记录上限 200 项或 1 MiB，单项正文保留最近 12,000 字符。
前端等待和绘制队列同样有界；溢出明确显示截断并重新对齐，不虚构漏掉的历史。
检查点也超过上限时明确显示不可用，仍可进入原生终端。
结束会话的观察缓存最多保留 12 份；运行服务重启会丢失这些临时记录，
对话和显式共享的持久记录保留。原始观察字节不进入持久状态或提示词。

- 实际 headless/xterm 屏幕逐单元比较覆盖 Unicode、宽字符、光标、颜色、样式、
  清屏、重绘、备用屏幕和 resize；不是仅比较最终一句话。
- 隐藏 Electron 的双成员输出、回看、跨会话阅读、断线和迟到快照检查通过。
  GUI-first 会话尚未创建 TUI 时自动显示结构化运行记录，不为观察启动一个 agent。
  手动上翻不被新输出拉走，返回实时才恢复跟随；输入框 DOM/焦点/草稿保留。
- 声明负载：两路各 100 小块、每块间隔 8 ms，另有 1,250 条突发截断检查。
  壳层接收到绘制回调的 P95 为 19–20 ms（204 次采样的一次最终回归为 19 ms）；
  不是模型端到端、跨机器或所有负载保证。该检查没有 native open/input/resize/send。
- Electron 资源采样覆盖浏览器、GPU、utility、renderer。一次压力前后 renderer
  working set 约 267 → 321 MiB；后段采样 CPU 约 1.5%。这些是短时采样，
  包含 Electron/测试页面，不是增量开销、长期稳定性或零资源成本证明。
- 可见 macOS 产品完成 CSV 小任务：Codex 读取/检查，真人 `@` Claude 独立核算；
  两者均得到 3 行和总数 23。实际工具、审批等待、最终结果和两成员原生画面可见。
  Claude 权限由真人在原生终端批准，接管使自动共享失效，结果保留在其私人会话。
  没有把原生审批当作新增共享许可。最终画面和工具事件有私有录像/原始日志。
- 同两会话再做测试后台故障退出及显式恢复：原生 ID、已有消息和成员关系保留，
  恢复未派发旧任务。恢复并不重建之前的活动团队或临时屏幕缓存。

本轮仅两次真实父会话提交：Claude Haiku 5.5 low 一次、Codex GPT-6 Luna low 一次，
未观察到新子 agent/工具外隐式任务。不把“父提交数”说成账单或总 token 成本。
Claude 原生恢复 hook 缺少模型字段时显示“原生未报告”，不编造默认模型。

原生 Desktop、无限 scrollback、永久工具日志、完整 fleet 生命周期、无损活动旧后台
热升级均未在这里实现；对应能力限制仍见 `readiness.md`。

## Retained alpha.2 Claude repair — alpha.25

The retained daemon is not patched or restarted. `legacy-observation.cjs` only
accepts the inspected alpha.2 Claude snapshot contract; other unknown contracts
remain gated. Existing terminal events schedule a canonical snapshot after a
40 ms debounce. There is no idle screen polling, terminal opening, control claim,
PTY resize or model call from observation. Native dimensions, tool counts, timing,
Unicode and alternate-screen contents are retained in bounded in-memory frames.
Selecting text freezes the selected frame until the user returns to live output.
Older overwritten content and changes between snapshots cannot be reconstructed;
this fallback is not the byte-complete current-backend journal.

The explicit **接通原会话输入** action installs this project's local compatibility
plugin in that session's project. Claude Code 2.1.302 was verified to load it using
native `/reload-plugins` without replacing the process. It reads the native draft,
authorizes the exact request against fresh portal ownership/state, reads the draft
again and uses native `$.prompt.submit({text, asUser: true})`. It never calls the
old paste/Enter sender. Native hooks remain the writer of user/reply history.
Reload is not automatically typed and `--force` is never added. Compatibility
code is dormant in new native processes that already have the normal bridge.

Local source checks and a real old daemon/Claude/Electron trial establish:

- One Haiku low-effort task submitted through the GUI runs a synthetic shell
  command and returns one reply. Exactly one native user message and one assistant
  message persist; tool count and elapsed-time text remain in the readonly native
  screen. Two native-draft rejection attempts create no model tasks.
- Closing/reopening the GUI reconnects the explicitly prepared link and preserves
  the same PID, native ID and messages, without replay or another plugin reload.
- Public xterm selection followed by new native output/resize retains the selected
  text; the actual Copy button returns it. This is not physical drag/IME evidence.
- The unmodified old daemon reproduces former-owner draft overwrite. Portal-wide
  ordering of legacy claims/drafts plus owner/control checks rejects that write.
  Queue, new-owner and newer-identical-draft regressions also protect ACK cleanup.

The task-complete screenshot is not evidence of an executing intermediate frame;
full terminal contents were checked separately. Host UI tests remain hidden to
avoid switching the person's macOS Space. Earlier unrelated visible OS input
results are reused, not relabelled as a fresh physical test. Raw logs/screenshots
are private. Legacy Codex input/observation and legacy automatic/shared dispatch
remain separate open work; no active fleet or original user session was migrated.

Plugin API references checked on 2026-10-19:
[reload](https://code.claude.com/docs/en/plugins/cli-reference#reload-plugins),
[project loading](https://code.claude.com/docs/en/plugins/loading),
[native prompt API](https://code.claude.com/docs/en/plugins/mods/api).
