# U17 Claude 2.1.310 能力归属审计（Claude lane 提供）

As of 2026-10-24。本文件是 [interaction](interaction.md) 中 U17 验收表的 Claude 310 部分，
由 Claude lane 提供并经其独立审查；主线合并时仅调整为现行审计口径。**Claude 实现与安装版验收未完成。**
每行明确归属 GUI 或同屏原生 TUI；命令和键位不再逐条执行验收。功能可用性仍受表中条件限制。

## GUI 事实（Claude 310，lane 交付状态，2026-10-25）

与 interaction 中 Codex 表同一标准：GUI 不与原生状态矛盾，交互留在同屏 TUI。
“源码运行”是 lane 工作树里的真实 Electron + Claude 2.1.310（本地固定回复，零付费）；
安装版验收由主线合并后完成。只处理改变会话身份或生命周期的命令，其余斜杠命令留在 TUI。

| GUI 事实 | 必须保持的含义 | 证据与状态 |
| --- | --- | --- |
| 线程身份 | clear/branch 跟随；普通 `/resume` 到别的会话不跟随且不冒充退出；`/background` 不冒充结束 | clear：`test-native-blocks.cjs`。branch：`test-native-branch.cjs`，alpha.97 安装版通过。`CL-INV-04`（`test-native-switch.cjs`，两种 case 各 1 次固定回复）：`/resume` 后行状态为“原生已切换会话”，进程、草稿与最后确认的身份保留，停止按钮可用；`/background` 后为“已转到后台运行”，活动写明后台会话 ID 与 `claude agents`/`claude attach`，不提供恢复旧 ID，可移除该行；应用重开后状态与说明保留（单元测试）；运行服务可正常关闭。先 `/resume` 到别的会话（含分支后切回原会话）再 `/background`，同样显示为转到后台；没有交接证据时显示“已结束”并写明切换到的会话是否继续无法确认（CL310-02，`NAW_SWITCH_CASE=resume-background`）。**复用 alpha.100 安装验收与 Fable16；该路径本轮未改动** |
| 状态 | 运行/空闲/结束/等审批/等回答/中断/排队；终端退出不冒充结束 | 中断：`test-native-abort.cjs`（310）。问题等待：alpha.94 安装版。排队：`test-native-queue.cjs` 放开 310 后源码运行通过（同一 nativeId/pid，排队只送达一次；运行摘要随私有证据保存）。后台转移见上行 |
| 给忙碌中的 Claude 排队发消息 | 如实说明何时送达；不冒充已丢失或已接收 | NAW 对话框和共享记录给工作中的 Claude 行发消息走 `$.prompt.submit`；2.1.310 引擎接口写明插件提交“空闲后才运行”，原生终端里打的字则进原生队列、在进行中的回合里送达。有原生 /goal 持续续跑时一直不空闲（用户 2026-10-25 反馈：消息等了约 24 分钟）。GUI 现在把这类消息标为“排队中，等空闲后发送”，并提示想中途插话就在原生终端输入（用户选定，不向终端注入按键）。`test-native-queue.cjs` 单人与共享两种模式断言这两处文字（真实 310，本地固定回复）。签名105安装包（提交7ca5642）单人/共享原生310验收通过，零付费推理 |
| 排队消息离开输入框 | 和原生终端排队一样，发出后输入框清空；没发出的回到输入框 | 用户 2026-10-25 反馈：发出后同一句话还留在输入框里，像没发出去（用户选定方案：进记录就清空）。消息一进记录，服务端清掉对应草稿，界面清空输入框。只有确定没发出（原生在授权提交前拒收：原生输入框有草稿、连接未就绪、守卫撤销、授权前超时）才标“没有发出”，并在输入框没被改过时放回原文；授权后结果不确定的标“结果未确认”，只留在记录里，不放回，避免重复发送。共享记录的草稿只存在当前视图：重新加载后，没发出的文字只在记录里。`test-native-queue.cjs` 单人与共享两种模式在真实 310 里测：原生提示符有草稿时排队被拒、标“没有发出”、原文回到输入框；正常排队时输入框为空（旧代码下失败）。安装版测试短暂停住独立profile的原生进程，实测输入框先清空，再恢复进程并核对原生草稿拒收及原文恢复；不是超时替代拒收。未知原生回执仍属结果未确认，不恢复为待发草稿。签名105安装包（提交7ca5642）单人/共享验收通过，零付费推理 |
| 左侧栏标出当前位置 | 一眼看出现在在哪个会话或协作空间 | 用户 2026-10-25 反馈：选中行只比别的行略亮，看不出当前在哪。选中底色和悬停色本来就很接近；现在当前会话行和“共同工作”在选中时加左侧竖条和细边框（用正文色，深浅色主题都可见），并标 `aria-current="page"`，读屏也能知道。`test-room-waiting.cjs` 断言任何时候只有一个当前位置、会话与协作空间都有可见标记（无模型）；深色宽窗口截图已核对。**待安装版验收** |
| 未命名会话自动起名 | 名字带原生 agent 名，来自 agent 自己的总结；手动改的名不被覆盖 | 用户 2026-10-25 反馈：默认名只有“Claude”“Codex”，开多了分不清（用户选：用原生生成的标题，先用第一句话）。0 付费探针证：Claude 只在未传 `--name` 时用小模型生成标题，只写在 transcript 的 `ai-title` 行，hook 的 `session_title` 和 `claude agents --json` 都拿不到；Codex TUI 在线程没有名字时把自己生成的标题设成线程名（源码 codex-rs/tui/src/app/event_dispatch.rs，GeneratedThreadTitle → Automatic → thread_set_name；独立审查指出，作者原先据二进制字符串误判为只是终端标题），只跑 app-server 时不生成。现在：创建时没起名的行不传 `--name`（因此每个未命名 Claude 会话多一次原生小模型标题请求，和直接在终端用一样），先显示“Claude/Codex · 第一句话”，Claude 的原生标题到了就换成“Claude · 标题”，Codex 收到原生线程名（TUI 生成的标题或 `/rename`）就换成“Codex · 名字”。实测：以终端视图新建的 Codex 行拿到了 TUI 标题；以对话视图新建时这次没有标题请求，行名保持第一句话。桌面改名存在 session-labels.json，显示时永远优先。`test-native-claude-create.cjs`（真实 310，1 次主请求 + 1 次标题，本地回复）与 `NAW_NATIVE_AUTO_NAME=1 test-native-codex-context.cjs`（真实 0.164，对话视图：第一句话后原生改名；加 `NAW_NATIVE_INITIAL_TERMINAL=1`：TUI 标题成为行名，1 次本地标题回复；原生改名经第二个 app-server 客户端）。**待安装版验收** |
| 新建时跳过所有权限确认 | 新建时可选，只影响这个会话；默认不勾，不改全局设置 | 用户 2026-10-25 反馈：新建时没有类似 dangerously skip permissions 的选项，进去后改不了（用户选：加复选框，默认不勾）。官方文档：Claude 只有以 `--permission-mode bypassPermissions` 或 `--allow-dangerously-skip-permissions` 启动，会话里才有 bypass；凡是有 bypass 的会话（包括勾选启动的），plan 模式都不再拦改文件（显式 ask 规则与 rm/rmdir 关键路径仍会问）。所以不给所有会话加 allow 参数，只让勾选的会话承担这个后果（独立审查指出作者原先只把它归到 allow 参数上）。新建对话框在后台支持时显示“跳过所有权限确认（危险）”，勾上后 Claude 首次以 `--permission-mode bypassPermissions` 启动（启动模式记在行上，第一次工具 hook 之前崩溃也按 bypass 恢复；之后以原生上报为准），Codex 以 `approvalPolicy: never` + `danger-full-access` 建线程（终端视图用 `-a never -s danger-full-access`）。新的原生配置第一次会在终端弹出 Claude 的 bypass 警告，由人确认；接受后 Claude 自己把 `skipDangerousModePermissionPrompt: true` 写进 `~/.claude/settings.json`，以后所有 Claude 会话都不再弹（这是原生行为，NAW 不写；用户本机已是该值）。`test-native-claude-create.cjs`（真实 310：参数、警告确认、状态栏显示 bypass）与 `NAW_NATIVE_SKIP_PERMISSIONS=1 test-native-codex-context.cjs`（真实 0.164，对话与终端视图，第二个客户端读到 never + 完全访问）。未验证：对话视图新建的 Claude bypass 行在新配置下弹警告时，对话侧如何提示。**待安装版验收** |
| 原生终端有颜色、配色照用户 iTerm2 | 原生程序的颜色照常显示；默认配色舒服 | 用户 2026-10-25 反馈：NAW 终端几乎只有黑白，iTerm2 里有颜色（要求：照 iTerm2 设置，先不加自定义入口，不覆盖原生程序自己的显示设置）。查明：所有 NAW 后台都从 Codex 的命令工具 shell 启动，继承了 `CODEX_CI=1` 和 `NO_COLOR=1`（还有 `TERM=dumb`、Codex 会话标识），`pty_host` 只覆盖 TERM/COLORTERM，原生 Claude/Codex 收到 `NO_COLOR=1` 就不出颜色。现在 `nativeEnvironment()` 在有 `CODEX_CI=1` 时不传 `NO_COLOR`（本人终端里设的 NO_COLOR 保留），并清掉启动方 agent 的会话标识。默认深色终端配色换成用户 iTerm2 默认 profile 的深色模式颜色（背景/前景/光标/选区/16 色，只读取颜色键），字体优先 MesloLGS NF；原生程序发的真彩色照原样画，绿色主题不变。`native-environment.test.cjs`；`test-native-claude-create.cjs` 以“从 Codex 工具 shell 启动”的环境运行，原生进程环境里没有这些变量、终端画出颜色（旧代码下失败）。已运行的会话要重启后才会拿到颜色。**待安装版验收** |
| 原生终端里 Shift+Enter 换行 | 和外部终端一样换行，不发送 | 2.1.310 启动时推 kitty 键盘协议（`CSI > 5 u`），把 `CSI 13;2u` 当换行，普通回车 `\r` 当发送；xterm 对 Shift+Enter 只发 `\r`（用户 2026-10-25 反馈：按 Shift+Enter 直接发出去了）。NAW 现在在 Claude 开启该协议时把 Shift+Enter 编成 `13;2u`，此前只对 Codex 生效；协议关闭时保持原样。`test-terminal-ime.cjs` 断言编码，`test-native-claude-fork.cjs` 在真实 310 终端里断言两行留在同一条草稿、发出后请求含换行（旧代码下失败）。**待安装版验收** |
| 用户输入、助手正文 | 原文不改写，真实流式边界才结束 | `test-native-blocks.cjs`（307–310）；alpha.94 安装版原文任务 |
| 工具调用与结果 | 原生公开字段、正文与终态；非文本只标未完整 | `test-native-blocks.cjs` 工具输入/完成/顺序；非文本结果只有单元测试 |
| 问题与选项 | 原文与等待状态；作答在 TUI | alpha.94 安装版自由回答与取消。多问题与多选：`test-native-blocks.cjs` `NAW_NATIVE_QUESTION_ANSWER=multi` 源码运行（310，2 次本地回复）：两个问题的标题、正文、全部选项与说明原样显示在 GUI，作答期间面板保持；在 TUI 选第一题、多选第二题两项、Tab 复核后提交，模型收到 `Unit tests, Build`，身份不变。GUI 不标注是否多选（作答在 TUI，那里显示勾选框）。**独立签名候选103验收通过；日常安装仍待许可** |
| Plan | GUI 不补写计划 | Claude 侧没有专门的 Plan 投影。`test-native-blocks.cjs` `NAW_TEST_NATIVE_PLAN=1` 源码运行（310，4 次本地回复）：会话以 plan 模式启动，模型写计划文件后调用 `ExitPlanMode`；原生把计划正文和文件路径填进这个请求（`plan`、`planFilePath`），GUI 面板按原样显示该请求，阅读区保留写文件的工具调用；在同屏 TUI 选“Yes, manually approve edits”后同一回合继续，身份不变，NAW 记录的权限模式由 plan 变为 default。面板显示的是原始 JSON，不是排版后的计划。**独立签名候选103验收通过；日常安装仍待许可** |
| 错误 | 原生错误正文原样，身份不变 | `test-native-error.cjs` 放开 310 后源码运行通过：阅读区与终端同显原生 400 正文，派发 1 次（运行摘要随私有证据保存） |
| 模型与 effort | 只显示原生报告 | 310 正向单元测试（有效切换、无效与超长忽略）；未知版本不读取。真实 310 切换：`NAW_MODEL_ONLY=1 test-native-queue.cjs` 源码运行（0 次模型调用）：TUI 中 `/model sonnet`→`haiku`→`sonnet`，GUI 标题随之更新，身份、PID 与草稿不变，重载后保留。Claude 的 GUI 不显示 effort，无矛盾可能（恢复时保留见“原生进程丢失后恢复”）。**独立签名候选103验收通过；日常安装仍待许可** |
| 用量 | 原生报告范围；未知不当零 | 310 正向单元测试（turn 结束后读取、缺值保持未知）；`test-native-addressed.cjs`（309/310）真实用量 |
| 回合起止、耗时 | GUI 不重建计时 | GUI 不显示 Claude 计时，完整页脚在 TUI，无矛盾可能 |
| 原生进程丢失后恢复 | 同一行、同一原生 ID、草稿与 goal；权限模式与 effort 不被静默改变；不重放中断的回合 | 原生 `--resume` 自行恢复模型和除 bypassPermissions 外的权限模式；bypass 回到新会话默认（auto），effort 按设置重新解析，会话内的选择（含 `--effort`、`max`）丢失（官方 sessions/model-config 文档；零付费 pty 探测）。NAW 记录根会话 hook 报告的最近权限模式与 effort，恢复时只补 `--permission-mode bypassPermissions`（最近为 bypass 时）和 `--effort <最近级别>`，其余交给原生。`test-native-claude-goal.cjs` `NAW_GOAL_CASE=recovery`：以 bypass 和 `--effort low` 启动，goal 第二回合进行中 SIGKILL 原生进程，经“继续原生会话”恢复：行/ID/草稿保留、PID 变化、TUI 回到 bypass、恢复后的回合仍为 low、8 秒内无回合自动开始，下一次提示后恢复的 goal 判定同一条件并完成（5 次本地回复）。边界：模式或 effort 在最后一个 hook 之后改变、随即进程死亡，恢复的是改变前的值；风险最大的是从 bypass 切走后崩溃、又被恢复成 bypass（原生 transcript 同样不记录这次切换）。未设 `skipDangerousModePermissionPrompt` 的配置在恢复时会出现原生 bypass 警告，会话停在启动中直到真人确认；设了该项（如本机）就没有这道确认。会话内临时打开的 ultracode 不在 hook 的 effort 级别里（报告为 xhigh），恢复后不会再打开。原生没有会话锁：零付费探测中，第二个并发的 `claude --resume <ID>` 打开了同一会话，成为第二个写入者。所以 NAW 恢复前检查是否有其他 claude 进程的参数含该 ID，有则拒绝并写明 PID（同一测试中由外部占用进程验证：拒绝、无回合开始，进程退出后正常恢复）；用 `--continue` 或选择器打开的会话参数里没有 ID，查不到。原生在下一回合开始后才把上一条回复写入记录（一次探测中不到 1 秒），在这之前被杀会丢失末尾，`--resume` 报找不到会话。用 `ps` 检查不可用时不拦截。**独立签名候选103验收通过；日常安装仍待许可** |
| 接入已有 Claude 会话（分支） | 原会话不受影响；新行有自己的原生 ID；不在 NAW 里解析内部转录格式 | 新建对话框选 Claude 后，原有入口按钮显示“从已有 Claude 会话分支…”（后台声明 `claudeFork` 才显示）。新行固定为原生终端视图，以 `claude --resume --fork-session --session-id <预分配 ID>` 启动；原生会话选择器在同屏终端里列出会话（Ctrl+A 显示所有项目），选中后原生分支到该 ID，此后恢复都用 `--resume <该 ID>`。官方文档：`--fork-session` 分支、原会话不变；转录格式是内部格式，所以不在 NAW 里列出或解析。2.1.310 零付费探测与 `test-native-claude-fork.cjs`（2 次本地回复）：分支带上原历史并能继续，原会话转录字节不变；在选择器按 Esc 不创建任何转录，行以“未选择会话，没有创建分支。”结束。原生限制：分支以新会话的权限模式启动（会话内授权和 bypass 不带过去）；对正在运行的会话分支，只复制已写入磁盘的部分。暂不支持直接接管（需先填会话 ID 才能在启动前检查占用）。**待安装版验收** |
| 接入差异 | 明示或由用户决定 | CL-X01–X08。用户 2026-10-25 决定：CL-X02 不再强制关闭遥测（与普通 claude 一致）；CL-X03 关闭自动 session recap（`awaySummaryEnabled: false`，手动 `/recap` 仍可用），auto 模式分类器保持原生行为。一次早期源码运行中观察到切换标签后出现 recap 后台请求，原始证据未保留，触发时机未证实；测试配置已关闭 recap |

问题：Claude 310 的 GUI 与原生 TUI 缺口没有完整清单。
现有机制：`app/adapters.cjs` 的 Claude 启动参数、`app/claude-bridge/hooks/register.js` 订阅的原生事件、同屏 xterm。
最小增量：按官方来源逐项列出，标明 GUI 原样或同屏原生 TUI，并单列 NAW 启动方式造成的差异。
不做会坏什么：被 NAW 启动参数关闭的原生功能会被误记成原生本身没有。

来源：Claude Code 闭源。来源只用官方文档（[llms.txt](https://code.claude.com/docs/llms.txt)）、
Claude Code 2.1.310 为 mod 写出的类型声明和本机 CLI 输出；没有拆安装包。例外（2026-10-25）：为写测试夹具（如 `/goal`
评估请求的系统提示），曾用 `strings` 只读查看已安装二进制中的字符串，未存入仓库；表中结论以运行验证或官方文档为据。文档会更新，
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

2026-10-25 用户决定后（CL-X02、CL-X03）：NAW 不再设置 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`，启动设置加入 `awaySummaryEnabled: false` 与 `promptSuggestionEnabled: false`。下方凡写“受 CL-X02 影响/NAW 启动时关闭/不可用”的行，记录的是设置了该变量时的探测；现在这些功能按普通 claude 的条件可用，未逐项实测。测试脚本仍为隔离起见设置该变量，所以真实测试证据与产品启动在这一点上不同。

发现证据 `CL-INV-02`：同样的隔离环境与启动方式，加了只记录 SessionStart/SessionEnd 的 hook。
1 次本地固定回复，零付费。`/branch`：进程不变，原生会话 ID 变化，事件为 SessionEnd `resume`
→ SessionStart `fork`。`/resume`：选择器可打开、Esc 取消。`/background`：内嵌终端里的进程退出
（SessionEnd `prompt_input_exit`），原生守护进程与 `bg-pty-host` 进程继续运行，hook 与屏幕显示新的会话 ID
（SessionStart `fork`，屏幕提示 `claude agents` / `claude attach`）。探测当时 NAW 只跟随 clear（后续 branch 跟随见 CL-INV-03），
终端退出即记为结束；两项的 GUI 表现是按源码推断，未在 GUI 里实测。探测结束时向本探测启动的后台进程发了 SIGTERM，
1.5 秒后仍有 2 个 `bg-pty-host` 在运行，复核时已退出。

发现与验收证据 `CL-INV-03`（`/branch` 跟随）：原生在 `/branch` 时先发 classic SessionStart（source `fork`），
此时 `$.session.id()` 仍返回旧 ID，之后才切换（事件顺序探测，1 次本地固定回复）。插件据此在 fork 时
先登记、发送前再确认新 ID 已成为当前会话；adapter 与 workspace 把 `resume → fork` 当作同进程的分支
跟随，边界标注为分支。真实 Electron + Claude 2.1.310 测试 `scripts/test-native-branch.cjs`：GUI 发一条
（固定回复）→ 在同屏 TUI 输入 `/branch` → GUI 跟到新会话 ID，同一行、同一进程、历史与草稿保留，
分支边界可见 → GUI 再发一条，回复在阅读区与 TUI 同现。2 次本地固定回复，零付费；测试日志记录
临时 profile 已删除，运行时另行核对的临时目录计数前后相同（计数不在日志里）；合成 Electron 上下文
测试与单元检查通过。事件顺序的结论来自一次探测样本。普通 `/resume` 换到别的会话不跟随，这一点只有
单元测试，未在真实 Claude 上验。

启动差异已明确披露：CL-X02（关闭遥测连带关闭的原生功能）和 CL-X03（原生自行发起的后台模型请求）。
按现行目标，披露即可继续验收；此处保留当前配置，未来若要改变再由用户决定。
CL-X07（预先放行 NAW 定向消息工具）影响真人控制，需在验收中写明。

| ID／功能 | 官方来源／条件 | GUI 或同屏原生 TUI；原因／当前缺口 | 证据与状态 |
| --- | --- | --- | --- |
| CL-I01 文字输入、换行、光标与单词编辑、撤销 | `interactive-mode#text-editing; keybindings chat:*` | GUI 原样；GUI 基本输入；原生专用编辑在同屏原生 TUI 里用，保留原生键位 | **待验** |
| CL-I02 粘贴与大段粘贴占位 `[Pasted text #N]` | `terminal-config#how-claude-treats-pasted-text` | 同屏原生 TUI；在同屏原生 TUI 里用；**“按粘贴而非打字处理”需要 feature flag，NAW 启动时不可用（CL-X02）** | **待验** |
| CL-I03 输入历史、Ctrl+R 反向搜索、找回清除的草稿、Vim 模式 | `interactive-mode#command-history; #vim-editor-mode` | 同屏原生 TUI；在同屏原生 TUI 里用；不另做历史或编辑器 | **待验** |
| CL-I04 运行中排队消息、取回排队、`/btw` 旁问 | `interactive-mode#queue-messages-while-claude-works; #side-questions-with-btw` | GUI 原样；GUI 发送走原生 `prompt.submit`；排队编辑与旁问在同屏原生 TUI 里用 | **待验** |
| CL-I05 `/` 命令补全、技能串联、`@` 文件提及、MCP prompts | `commands#how-the-command-menu-matches-what-you-type` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生补全与上下文绑定 | **待验** |
| CL-I06 图片粘贴与附件 | `keybindings#attachments-actions` | 同屏原生 TUI；显式粘贴/拖入通过同一原生附件输入区，文字草稿保留 | 三入口原生图片载荷核验使用 `test-native-blocks.cjs` 的 `NAW_TEST_NATIVE_IMAGE=1`，物理系统剪贴板仍待验；签名候选104验收通过，1 次本地回复、3 张同像素图片；日常安装待许可 |
| CL-I07 `!` shell 模式与后台 Bash | `interactive-mode#shell-mode-with--prefix; #background-bash-commands` | 同屏原生 TUI；在同屏原生 TUI 里用；不另起 shell 生命周期 | **待验** |
| CL-I08 提示建议（灰字示例与下一步建议） | `interactive-mode#prompt-suggestions` | **NAW 关闭**：启动设置 `promptSuggestionEnabled: false`（CL-X01） | 待安装版验收 |
| CL-I09 拼写检查、emoji 短码、不可见字符提示 | `interactive-mode#check-spelling-as-you-type; #emoji-shortcodes` | 同屏原生 TUI；在同屏原生 TUI 里用 | **待验** |
| CL-I10 语音输入 | `interactive-mode#voice-input` | 同屏原生 TUI；在同屏原生 TUI 里用；物理麦克风需实测 | **待验** |
| CL-R01 助手正文流式显示、Markdown、链接 | `hooks#messagedisplay; engine ui.render` | GUI 原样；GUI 原文（`classic.MessageDisplay` 的可见内容）；原生排版在同屏原生 TUI 里用 | **待验** |
| CL-R02 思考、请求/流式阶段、spinner、计时与 token | `engine turn.step` | GUI 原样；GUI 只显示原生阶段种类（requesting/thinking/text/input/tool）；原生 spinner 文字与计时在同屏原生 TUI 里用，不翻译 | **待验** |
| CL-R03 工具调用、输入、结果、失败 | `engine tool.call; session.append` | GUI 原样；GUI 原生工具名、输入 JSON 与文本结果；非文本结果只标未完整，原样在同屏原生 TUI 里用 | **待验** |
| CL-R04 文件 diff、`/diff` 面板与 diff 对话框 | `interactive-mode#review-changes-with-diff` | 同屏原生 TUI；在同屏原生 TUI 里用 | **待验** |
| CL-R05 任务清单（Ctrl+T to-do） | `interactive-mode#task-list` | 同屏原生 TUI；在同屏原生 TUI 里用；GUI 只见对应工具调用，不重画清单 | **待验** |
| CL-R06 子 agent、Agent Teams、后台任务与 `/tasks` | `sub-agents; agent-teams; agent-view` | 同屏原生 TUI；在同屏原生 TUI 里用；GUI 过滤 `agentId` 事件，不把子 agent 当根会话 | **待验** |
| CL-R07 完成时间、耗时与回合页脚 | `engine turn.complete` | GUI 原样；GUI 只显示原生回合边界与状态；完整页脚在同屏原生 TUI 里用，不重建时钟 | **待验** |
| CL-R08 Session recap 与 `/recap` | `interactive-mode#session-recap` | 同屏原生 TUI；在同屏原生 TUI 里用；**自动 recap 默认开启且是后台模型请求（CL-X03）** | **待验** |
| CL-R09 用量、上下文、额度等待与自动继续 | `interactive-mode#wait-for-a-usage-limit-to-reset; costs` | GUI 原样；GUI 只显示 `session.usage()` 范围；完整状态与等待在同屏原生 TUI 里用 | **待验** |
| CL-R10 状态行（statusline） | `statusline` | 同屏原生 TUI；在同屏原生 TUI 里用；按用户自己的 statusline 设置 | **待验** |
| CL-R11 PR/MR 状态徽标 | `interactive-mode#pr-review-status` | 同屏原生 TUI；**NAW 启动时关闭**：同一变量关闭 PR/MR 状态检查（CL-X02） | **待验** |
| CL-R12 全屏渲染、鼠标、滚动与选择 | `fullscreen` | 同屏原生 TUI；在同屏原生 TUI 里用；**内嵌 xterm 的鼠标与 alt-screen 行为待实测** | **待验** |
| CL-A01 工具权限请求与决定 | `permission-modes; hooks#permissionrequest` | GUI 原样；GUI 原样显示请求（工具名与输入）；决定在同屏原生 TUI 里做，NAW 不代答 | **待验** |
| CL-A02 AskUserQuestion 问题、选项与自由回答 | `engine ui.render AskUserQuestion` | GUI 原样；GUI 原样显示问题与选项；作答与取消在同屏原生 TUI 里用 | **待验** |
| CL-A03 Plan 模式与退出 Plan 的确认 | `permission-modes#analyze-before-you-edit-with-plan-mode` | 同屏原生 TUI；在同屏原生 TUI 里用；GUI 只见对应权限请求 | **待验** |
| CL-A04 MCP elicitation 表单与密钥 | `hooks#elicitation` | 同屏原生 TUI；在同屏原生 TUI 里用；不导出表单或密钥 | **待验** |
| CL-A05 权限模式与切换（Shift+Tab 等） | `permission-modes; auto-mode-classifier-billing` | 同屏原生 TUI；在同屏原生 TUI 里用；NAW 当前不传 `--permission-mode`，原生默认为 auto（探测启动横幅可见）；分类器请求见 CL-X03 | **待验** |
| CL-S01 新建、恢复、分支、fork、teleport 与根会话身份 | `sessions; commands` | GUI 原样；GUI 跟随原生 clear 与 branch（CL-INV-03）；**`/background` 已实测换会话 ID 且内嵌进程退出（CL-INV-02），按源码 NAW 记为结束，GUI 实测待验**；resume/teleport/tui 待验 | **待验** |
| CL-S02 模型、effort、fast mode、output style | `model-config; fast-mode; output-styles` | GUI 原样；GUI 只跟随模型名；选择器在同屏原生 TUI 里用；**fast mode 可用性检查被 CL-X02 关闭，影响待验** | **待验** |
| CL-S03 配置、记忆、技能、hooks、插件、主题、快捷键设置 | `commands; settings-reference` | 同屏原生 TUI；在同屏原生 TUI 里用；**云端同步的技能与插件因 CL-X02 不加载** | **待验** |
| CL-S04 检查点与 `/rewind` | `checkpointing` | 同屏原生 TUI；在同屏原生 TUI 里用；**回退对 GUI 已显示记录的影响待验** | **待验** |
| CL-S05 上下文压缩（手动、自动、空闲压缩） | `hooks#precompact; settings-reference#idlecompaction` | 同屏原生 TUI；在同屏原生 TUI 里用；**空闲压缩需要 feature flag，NAW 启动时不可用（CL-X02）** | **待验** |
| CL-S06 错误、重试、重新登录与恢复 | `errors` | GUI 原样；GUI 原样显示原生 API 错误正文与失败边界；恢复操作在同屏原生 TUI 里用 | **待验** |
| CL-S07 通知、终端标题、无障碍 | `terminal-config` | 同屏原生 TUI；在同屏原生 TUI 里用；**内嵌 xterm 是否转发系统通知与标题待实测** | **待验** |
| CL-X01 `--prompt-suggestions false` | `app/adapters.cjs Claude 启动参数; cli-reference; interactive-mode#turn-prompt-suggestions-off` | **已处理（2026-10-25）**：该参数按文档只用于 `--print`；交互模式改由启动设置 `promptSuggestionEnabled: false` 关闭（官方交互开关），因为每条建议是一次后台模型请求 | 待安装版验收 |
| CL-X02 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | `env-vars#features-that-need-feature-flag-fetching; env-vars CLAUDE_CODE_ARTIFACT_COMMENTS` | **已决定（2026-10-25）**：NAW 不再设置该变量，遥测、feature flag 与相关原生功能与用户自己的 claude 一致 | 待安装版验收 |
| CL-X03 原生自行发起的后台模型请求 | `interactive-mode#session-recap; settings-reference#awaysummaryenabled; permission-modes; auto-mode-classifier-billing` | **已决定（2026-10-25）**：NAW 启动设置 `awaySummaryEnabled: false` 关闭自动 session recap，手动 `/recap` 可用；auto 模式分类器保持原生行为 | 待安装版验收 |
| CL-X04 Agent Teams 打开且 `teammateMode: in-process` | `env-vars CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS; settings-reference#teammatemode` | 同屏原生 TUI；有意设置：在同一终端内显示队友，不拆 tmux 窗格 | **待验** |
| CL-X05 附加 MCP 服务 `native_workspace` 与插件目录 | `app/adapters.cjs Claude 启动参数` | 同屏原生 TUI；有意添加：`/mcp` 与工具列表多出 NAW 的定向消息工具 | **待验** |
| CL-X06 `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` | `env-vars` | 同屏原生 TUI；有意设置：不自动安装官方插件市场 | **待验** |
| CL-X07 `--allowedTools mcp__native_workspace__workspace_message` | `app/adapters.cjs Claude 启动参数; register.js tool.call` | 同屏原生 TUI；有意设置：预先允许 NAW 的定向消息工具，原生不再为它弹权限确认；是否放行改由 NAW 自己的协作授权检查决定。**影响真人控制，需在验收中写明** | **待验** |
| CL-X08 设置文件加入 14 个 command hook | `app/adapters.cjs Claude 启动参数; app/claude_hook.py` | 同屏原生 TUI；有意设置：只做本地观察、不回答原生审批，每个 hook 限时 2 秒；`/hooks` 会列出这些 hook | **待验** |
| CL-CMD001 `/add-dir <path>` | [命令:52](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD002 `/advisor [model\|off]` | [命令:53](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；**按文档在 NAW 启动环境下不可用**：advisor 需要 feature flag（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；启动差异见 CL-X02；已于 2026-10-25 取消该变量 |
| CL-CMD003 `/agents` | [命令:54](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；2.1.310 菜单标为 (removed)，只打印提醒 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD004 `/artifact-capabilities` | [命令:55](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；**按文档在 NAW 启动环境下不可用**（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；启动差异见 CL-X02；已于 2026-10-25 取消该变量 |
| CL-CMD005 `/artifact-diagramming` | [命令:56](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；**按文档在 NAW 启动环境下不可用**（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；启动差异见 CL-X02；已于 2026-10-25 取消该变量 |
| CL-CMD006 `/artifacts` | [命令:57](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；**按文档在 NAW 启动环境下不可用**（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；启动差异见 CL-X02；已于 2026-10-25 取消该变量 |
| CL-CMD007 `/auto-mode-setup` | [命令:58](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD008 `/autocompact [auto\|<tokens>]` | [命令:59](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD009 `/autofix-pr [prompt]` | [命令:60](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD010 `/background [prompt]` | [命令:61](https://code.claude.com/docs/en/commands)；别名 `/bg` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；**缺口（CL-INV-02）**：内嵌终端里的原生进程退出（SessionEnd `prompt_input_exit`），原生守护进程继续运行，hook 显示新会话 ID（SessionStart `fork`）；按源码，NAW 会按终端退出把会话记为结束、看不到后台会话，GUI 实测待验 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD011 `/batch <instruction>` | [命令:62](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD012 `/branch [name]` | [命令:63](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 跟随（CL-INV-03）：同一进程换到新会话 ID（SessionEnd `resume` → SessionStart `fork`），GUI 保留同一行、进程、历史与草稿，记一条分支边界，发送继续到分支会话 | CL-INV-03：无参数 `/branch` 已在真实 Electron+Claude 跟随；`/branch name` 待验 |
| CL-CMD013 `/btw [question]` | [命令:64](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD014 `/bug [report]` | [命令:65](https://code.claude.com/docs/en/commands)；别名 `/share` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD015 `/cd <path>` | [命令:66](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD016 `/chrome` | [命令:67](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD017 `/claude-api [migrate\|upgrade\|api-version\|managed-agents-onboard\|managed-agents-secure\|prompt-audit\|cost-optimize\|build-eval\|hillclimb\|preserved-thinking-migration]` | [命令:68](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD018 `/claude-in-chrome [task]` | [命令:69](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；只在本会话开启 Chrome 集成时出现；**待条件下验收** |
| CL-CMD019 `/clear [name]` | [命令:70](https://code.claude.com/docs/en/commands)；别名 `/reset`、`/new` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 跟随原生清空后的新根会话（`register.js` session.end + SessionStart clear） | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD020 `/code-review [low\|medium\|high\|xhigh\|max\|ultra] [--fix] [--comment] [--max-findings n\|all\|default] [pr#\|branch\|path]` | [命令:71](https://code.claude.com/docs/en/commands)；内置技能；别名 `/review` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD021 `/color [color\|default]` | [命令:72](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD022 `/compact [instructions]` | [命令:73](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD023 `/config [key=value ...]` | [命令:74](https://code.claude.com/docs/en/commands)；别名 `/settings` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD024 `/context [all]` | [命令:75](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD025 `/copy [N]` | [命令:76](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；经内嵌终端写系统剪贴板，**待实测** | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD026 `/cost` | [命令:77](https://code.claude.com/docs/en/commands)；`/usage` 的别名 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 只显示原生 `session.usage()` 的范围用量 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD027 `/dataviz [request]` | [命令:78](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD028 `/debug [description]` | [命令:79](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD029 `/deep-research <question>` | [命令:80](https://code.claude.com/docs/en/commands)；内置工作流 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD030 `/design [brief]` | [命令:81](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD031 `/design consent` | [命令:82](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD032 `/design revoke` | [命令:82](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD033 `/design-login` | [命令:83](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD034 `/design-sync [hint]` | [命令:84](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD035 `/desktop` | [命令:85](https://code.claude.com/docs/en/commands)；别名 `/app` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD036 `/diff` | [命令:86](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD037 `/doctor [prompt-audit [path]]` | [命令:87](https://code.claude.com/docs/en/commands)；内置技能；别名 `/checkup` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD038 `/effort [level\|auto\|status\|ultracode [on\|off]]` | [命令:88](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD039 `/exit` | [命令:89](https://code.claude.com/docs/en/commands)；别名 `/quit` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 只跟随原生退出状态 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD040 `/export [filename]` | [命令:90](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD041 `/fast [on\|off]` | [命令:91](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD042 `/feedback [report]` | [命令:92](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；文档称 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 关闭 `/feedback`，菜单仍列出，**执行结果待验**（CL-X02） | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD043 `/fewer-permission-prompts` | [命令:93](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD044 `/focus` | [命令:94](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD045 `/fork [prompt]` | [命令:95](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；复制到新的后台会话，**该会话在 GUI 中如何出现待验** | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD046 `/goal [condition\|clear]` | [命令:96](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD047 `/heapdump` | [命令:97](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD048 `/help` | [命令:98](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD049 `/hooks` | [命令:99](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD050 `/ide` | [命令:100](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD051 `/import [codex\|gemini\|cursor] [--dry-run] [--yes]` | [命令:101](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；**按文档在 NAW 启动环境下不可用**：需要 feature flag（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；启动差异见 CL-X02；已于 2026-10-25 取消该变量 |
| CL-CMD052 `/init` | [命令:102](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD053 `/insights` | [命令:103](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD054 `/install-github-app` | [命令:104](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD055 `/install-slack-app` | [命令:105](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD056 `/keybindings` | [命令:106](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD057 `/list-agents` | [命令:107](https://code.claude.com/docs/en/commands)；别名 `/peers` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD058 `/login` | [命令:108](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD059 `/logout` | [命令:109](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD060 `/loop [interval] [prompt]` | [命令:110](https://code.claude.com/docs/en/commands)；内置技能；别名 `/proactive` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD061 `/mcp [reconnect (<server>\|all)\|enable\|disable [<server>\|all]]` | [命令:111](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD062 `/memory` | [命令:112](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD063 `/mobile` | [命令:113](https://code.claude.com/docs/en/commands)；别名 `/ios`、`/android` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD064 `/model [model]` | [命令:114](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 标题跟随原生 `PostModelSwitch` 的 `to_model` | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD065 `/output-style [style]` | [命令:115](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD066 `/passes` | [命令:116](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD067 `/permissions` | [命令:117](https://code.claude.com/docs/en/commands)；别名 `/allowed-tools` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD068 `/plan [description]` | [命令:118](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD069 `/plugin [subcommand]` | [命令:119](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD070 `/plugin-authoring` | [命令:120](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD071 `/powerup` | [命令:121](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD072 `/pr-comments [PR]` | [命令:122](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；原生已移除（文档注明），无需映射 | INV：菜单未列出；原生已移除 |
| CL-CMD073 `/privacy-settings` | [命令:123](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD074 `/radio` | [命令:124](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD075 `/rate-limit-options` | [命令:125](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD076 `/recap` | [命令:126](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；原生自己生成，GUI 不另调模型 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD077 `/release-notes` | [命令:127](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；文档称同一变量关闭 release notes，菜单仍列出，**执行结果待验**（CL-X02） | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD078 `/reload-plugins [--force]` | [命令:128](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD079 `/reload-skills` | [命令:129](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD080 `/remote-control` | [命令:130](https://code.claude.com/docs/en/commands)；别名 `/rc` | 同屏原生 TUI；**按文档在 NAW 启动环境下不可用**：Remote Control 需要 feature flag（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；启动差异见 CL-X02；已于 2026-10-25 取消该变量 |
| CL-CMD081 `/remote-env` | [命令:131](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD082 `/rename [name]` | [命令:132](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD083 `/resume [session]` | [命令:133](https://code.claude.com/docs/en/commands)；别名 `/continue` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；会在同一终端换到另一会话；选择器已实测可打开与取消，换会话后 GUI 是否跟随待验（现只跟随 clear） | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD084 `/review [low\|medium\|high\|xhigh\|max\|ultra] [--fix] [--comment] [--max-findings n\|all\|default] [pr#\|branch\|path]` | [命令:134](https://code.claude.com/docs/en/commands)；`/code-review` 的别名 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD085 `/rewind` | [命令:135](https://code.claude.com/docs/en/commands)；别名 `/checkpoint`、`/undo` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD086 `/run` | [命令:136](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD087 `/run-skill-generator` | [命令:137](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD088 `/sandbox` | [命令:138](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD089 `/schedule [description]` | [命令:139](https://code.claude.com/docs/en/commands)；别名 `/routines` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD090 `/scroll-speed` | [命令:140](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD091 `/security-review` | [命令:141](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD092 `/setup-bedrock` | [命令:142](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD093 `/setup-vertex` | [命令:143](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD094 `/simplify [target]` | [命令:144](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD095 `/skill-doctor` | [命令:145](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；**按文档在 NAW 启动环境下不可用**：需要 feature flag（CL-X02） | INV：菜单未列出；按文档受 CL-X02 影响，但探测是首次会话且无对照，不能单独证明原因；启动差异见 CL-X02；已于 2026-10-25 取消该变量 |
| CL-CMD096 `/skills` | [命令:146](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD097 `/slides [brief]` | [命令:147](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD098 `/stats` | [命令:148](https://code.claude.com/docs/en/commands)；`/usage` 的别名 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 只显示原生 `session.usage()` 的范围用量 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD099 `/status` | [命令:149](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD100 `/statusline` | [命令:150](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD101 `/stickers` | [命令:151](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD102 `/stop` | [命令:152](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；只在已附着后台会话时出现；**待条件下验收** |
| CL-CMD103 `/subtask <task>` | [命令:153](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD104 `/tasks` | [命令:154](https://code.claude.com/docs/en/commands)；别名 `/bashes` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD105 `/team-onboarding` | [命令:155](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD106 `/teleport` | [命令:156](https://code.claude.com/docs/en/commands)；别名 `/tp` | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；**把云端会话拉进本终端，GUI 根会话是否跟随待验** | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD107 `/terminal-setup` | [命令:157](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD108 `/theme` | [命令:158](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD109 `/tui [default\|fullscreen]` | [命令:159](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；**会以新渲染器重启原生进程，GUI 是否保持同一原生身份待验** | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD110 `/ultraplan <prompt>` | [命令:160](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；原生已移除（文档注明），无需映射 | INV：菜单未列出；原生已移除 |
| CL-CMD111 `/ultrareview [PR or branch]` | [命令:161](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD112 `/update-config [request]` | [命令:162](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD113 `/upgrade` | [命令:163](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD114 `/usage` | [命令:164](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；GUI 只显示原生 `session.usage()` 的范围用量 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD115 `/usage-credits` | [命令:165](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD116 `/verify` | [命令:166](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD117 `/vim` | [命令:167](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；原生已移除（文档注明），无需映射 | INV：菜单未列出；原生已移除 |
| CL-CMD118 `/voice [hold\|tap\|off]` | [命令:168](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置；麦克风由原生进程直接取用，物理设备需实测 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD119 `/web-setup` | [命令:169](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：菜单未列出；需 claude.ai 订阅、`gh` 登录、云会话或 Chrome 等条件；探测用 API key fixture，无法区分是账号条件还是 CL-X02，**需在用户真实登录环境核对** |
| CL-CMD120 `/workflow-authoring` | [命令:170](https://code.claude.com/docs/en/commands)；内置技能 | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-CMD121 `/workflows` | [命令:171](https://code.claude.com/docs/en/commands) | 同屏原生 TUI；在同屏原生 TUI 里用；保留原生分派、菜单和配置 | INV：NAW 启动参数与环境下菜单列出；归属审计；不逐项执行验收 |
| CL-KEY001 `app:interrupt` | [键位:89](https://code.claude.com/docs/en/keybindings)；Global；默认 Ctrl+C | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器；GUI 中断另走原生 `turn.abort` | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY002 `app:exit` | [键位:90](https://code.claude.com/docs/en/keybindings)；Global；默认 Ctrl+D | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY003 `app:redraw` | [键位:91](https://code.claude.com/docs/en/keybindings)；Global；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY004 `app:toggleTodos` | [键位:92](https://code.claude.com/docs/en/keybindings)；Global；默认 Ctrl+T | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY005 `app:toggleTranscript` | [键位:93](https://code.claude.com/docs/en/keybindings)；Global；默认 Ctrl+O | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY006 `history:search` | [键位:101](https://code.claude.com/docs/en/keybindings)；文档未写上下文；默认 Ctrl+R | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY007 `history:previous` | [键位:102](https://code.claude.com/docs/en/keybindings)；文档未写上下文；默认 Up | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY008 `history:next` | [键位:103](https://code.claude.com/docs/en/keybindings)；文档未写上下文；默认 Down | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY009 `chat:cancel` | [键位:111](https://code.claude.com/docs/en/keybindings)；Chat；默认 Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY010 `chat:clearInput` | [键位:112](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+L | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY011 `chat:clearScreen` | [键位:113](https://code.claude.com/docs/en/keybindings)；Chat；默认 Cmd+K | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY012 `chat:killAgents` | [键位:114](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+X Ctrl+K | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY013 `chat:cycleMode` | [键位:115](https://code.claude.com/docs/en/keybindings)；Chat；默认 Shift+Tab\* | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY014 `chat:modelPicker` | [键位:116](https://code.claude.com/docs/en/keybindings)；Chat；默认 Meta+P | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY015 `chat:fastMode` | [键位:117](https://code.claude.com/docs/en/keybindings)；Chat；默认 Meta+O | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY016 `chat:thinkingToggle` | [键位:118](https://code.claude.com/docs/en/keybindings)；Chat；默认 Meta+T | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY017 `chat:submit` | [键位:119](https://code.claude.com/docs/en/keybindings)；Chat；默认 Enter | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY018 `chat:queueSubmit` | [键位:120](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+X Enter | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY019 `chat:sendNow` | [键位:121](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+Enter, Ctrl+X Ctrl+S | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY020 `chat:newline` | [键位:122](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+J | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY021 `chat:undo` | [键位:123](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+\_, Ctrl+Shift+- | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY022 `chat:externalEditor` | [键位:124](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+G, Ctrl+X Ctrl+E | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY023 `chat:stash` | [键位:125](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+S | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY024 `chat:imagePaste` | [键位:126](https://code.claude.com/docs/en/keybindings)；Chat；默认 Ctrl+V (Alt+V on Windows and WSL) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY025 `command:<name>` | [键位:127](https://code.claude.com/docs/en/keybindings)；Chat；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY026 `autocomplete:accept` | [键位:137](https://code.claude.com/docs/en/keybindings)；Autocomplete；默认 Tab | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY027 `autocomplete:dismiss` | [键位:138](https://code.claude.com/docs/en/keybindings)；Autocomplete；默认 Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY028 `autocomplete:previous` | [键位:139](https://code.claude.com/docs/en/keybindings)；Autocomplete；默认 Up | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY029 `autocomplete:next` | [键位:140](https://code.claude.com/docs/en/keybindings)；Autocomplete；默认 Down | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY030 `confirm:yes` | [键位:148](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Enter | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY031 `confirm:no` | [键位:149](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY032 `confirm:previous` | [键位:150](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Up | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY033 `confirm:next` | [键位:151](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Down | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY034 `confirm:nextField` | [键位:152](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Tab | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY035 `confirm:previousField` | [键位:153](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY036 `confirm:toggle` | [键位:154](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Space | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY037 `confirm:cycleMode` | [键位:155](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 Shift+Tab\* | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY038 `permission:toggleDebug` | [键位:191](https://code.claude.com/docs/en/keybindings)；Confirmation；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY039 `transcript:toggleShowAll` | [键位:199](https://code.claude.com/docs/en/keybindings)；Transcript；默认 Ctrl+E | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY040 `transcript:exit` | [键位:200](https://code.claude.com/docs/en/keybindings)；Transcript；默认 q, Ctrl+C, Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY041 `historySearch:next` | [键位:210](https://code.claude.com/docs/en/keybindings)；HistorySearch；默认 Ctrl+R | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY042 `historySearch:accept` | [键位:211](https://code.claude.com/docs/en/keybindings)；HistorySearch；默认 Escape, Tab | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY043 `historySearch:cancel` | [键位:212](https://code.claude.com/docs/en/keybindings)；HistorySearch；默认 Ctrl+C | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY044 `historySearch:execute` | [键位:213](https://code.claude.com/docs/en/keybindings)；HistorySearch；默认 Enter | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY045 `historySearch:cycleScope` | [键位:214](https://code.claude.com/docs/en/keybindings)；HistorySearch；默认 Ctrl+S | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY046 `task:background` | [键位:224](https://code.claude.com/docs/en/keybindings)；Task；默认 Ctrl+B, Ctrl+X Ctrl+B | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY047 `theme:toggleSyntaxHighlighting` | [键位:232](https://code.claude.com/docs/en/keybindings)；ThemePicker；默认 Ctrl+T | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY048 `help:dismiss` | [键位:240](https://code.claude.com/docs/en/keybindings)；Help；默认 Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY049 `tabs:next` | [键位:248](https://code.claude.com/docs/en/keybindings)；Tabs；默认 Tab, Right | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY050 `tabs:previous` | [键位:249](https://code.claude.com/docs/en/keybindings)；Tabs；默认 Shift+Tab, Left | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY051 `attachments:next` | [键位:261](https://code.claude.com/docs/en/keybindings)；Attachments；默认 Right | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY052 `attachments:previous` | [键位:262](https://code.claude.com/docs/en/keybindings)；Attachments；默认 Left | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY053 `attachments:remove` | [键位:263](https://code.claude.com/docs/en/keybindings)；Attachments；默认 Backspace, Delete | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY054 `attachments:exit` | [键位:264](https://code.claude.com/docs/en/keybindings)；Attachments；默认 Down, Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY055 `footer:next` | [键位:272](https://code.claude.com/docs/en/keybindings)；Footer；默认 Right | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY056 `footer:previous` | [键位:273](https://code.claude.com/docs/en/keybindings)；Footer；默认 Left | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY057 `footer:up` | [键位:274](https://code.claude.com/docs/en/keybindings)；Footer；默认 Up, Ctrl+P | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY058 `footer:down` | [键位:275](https://code.claude.com/docs/en/keybindings)；Footer；默认 Down, Ctrl+N | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY059 `footer:openSelected` | [键位:276](https://code.claude.com/docs/en/keybindings)；Footer；默认 Enter | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY060 `footer:clearSelection` | [键位:277](https://code.claude.com/docs/en/keybindings)；Footer；默认 Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY061 `footer:close` | [键位:278](https://code.claude.com/docs/en/keybindings)；Footer；默认 x | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY062 `footer:dismiss` | [键位:279](https://code.claude.com/docs/en/keybindings)；Footer；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY063 `diff:dismiss` | [键位:314](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY064 `diff:previousSource` | [键位:315](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Left | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY065 `diff:nextSource` | [键位:316](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Right | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY066 `diff:previousFile` | [键位:317](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Up, K | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY067 `diff:nextFile` | [键位:318](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Down, J | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY068 `diff:back` | [键位:319](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY069 `scroll:pageUp` | [键位:329](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 PageUp | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY070 `scroll:pageDown` | [键位:330](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 PageDown | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY071 `scroll:fullPageUp` | [键位:331](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Shift+Space, B | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY072 `scroll:fullPageDown` | [键位:332](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Space | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY073 `scroll:top` | [键位:333](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 G, Home | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY074 `scroll:bottom` | [键位:334](https://code.claude.com/docs/en/keybindings)；DiffDialog；默认 Shift+G, End | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY075 `app:toggleReplTab` | [键位:344](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY076 `app:cycleDiffBase` | [键位:345](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 Ctrl+X B | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY077 `app:diffFileListUp` | [键位:346](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 Ctrl+Up, Meta+Up | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY078 `app:diffFileListDown` | [键位:347](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 Ctrl+Down, Meta+Down | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY079 `app:toggleDiffNoiseFilter` | [键位:348](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY080 `app:toggleDiffPreSession` | [键位:349](https://code.claude.com/docs/en/keybindings)；上下文见文档第 338 行；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY081 `modelPicker:decreaseEffort` | [键位:357](https://code.claude.com/docs/en/keybindings)；ModelPicker；默认 Left | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY082 `modelPicker:increaseEffort` | [键位:358](https://code.claude.com/docs/en/keybindings)；ModelPicker；默认 Right | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY083 `modelPicker:thisSessionOnly` | [键位:359](https://code.claude.com/docs/en/keybindings)；ModelPicker；默认 s | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY084 `effortSlider:decreaseEffort` | [键位:367](https://code.claude.com/docs/en/keybindings)；EffortSlider；默认 Left | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY085 `effortSlider:increaseEffort` | [键位:368](https://code.claude.com/docs/en/keybindings)；EffortSlider；默认 Right | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY086 `effortSlider:toggleUltracode` | [键位:369](https://code.claude.com/docs/en/keybindings)；EffortSlider；默认 Tab | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY087 `effortSlider:thisSessionOnly` | [键位:370](https://code.claude.com/docs/en/keybindings)；EffortSlider；默认 s | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY088 `select:next` | [键位:378](https://code.claude.com/docs/en/keybindings)；Select；默认 Down, J, Ctrl+N | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY089 `select:previous` | [键位:379](https://code.claude.com/docs/en/keybindings)；Select；默认 Up, K, Ctrl+P | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY090 `select:pageUp` | [键位:380](https://code.claude.com/docs/en/keybindings)；Select；默认 PageUp | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY091 `select:pageDown` | [键位:381](https://code.claude.com/docs/en/keybindings)；Select；默认 PageDown | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY092 `select:first` | [键位:382](https://code.claude.com/docs/en/keybindings)；Select；默认 Home | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY093 `select:last` | [键位:383](https://code.claude.com/docs/en/keybindings)；Select；默认 End | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY094 `select:accept` | [键位:384](https://code.claude.com/docs/en/keybindings)；Select；默认 Enter | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY095 `select:cancel` | [键位:385](https://code.claude.com/docs/en/keybindings)；Select；默认 Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY096 `plugin:toggle` | [键位:399](https://code.claude.com/docs/en/keybindings)；Plugin；默认 Space | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY097 `plugin:install` | [键位:400](https://code.claude.com/docs/en/keybindings)；Plugin；默认 I | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY098 `plugin:favorite` | [键位:401](https://code.claude.com/docs/en/keybindings)；Plugin；默认 F | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY099 `abovePrompt:toggle` | [键位:409](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Ctrl+X Ctrl+A | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY100 `abovePrompt:focus` | [键位:410](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Ctrl+X Tab | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY101 `abovePrompt:next` | [键位:411](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Tab | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY102 `abovePrompt:previous` | [键位:412](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Shift+Tab | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY103 `abovePrompt:press` | [键位:413](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Enter | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY104 `abovePrompt:leave` | [键位:414](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY105 `abovePrompt:highlightNext` | [键位:415](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Down | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY106 `abovePrompt:highlightPrevious` | [键位:416](https://code.claude.com/docs/en/keybindings)；上下文见文档第 405 行；默认 Up | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY107 `pane:scrollUp` | [键位:428](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Up | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY108 `pane:scrollDown` | [键位:429](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Down | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY109 `pane:pageUp` | [键位:430](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 PageUp | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY110 `pane:pageDown` | [键位:431](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 PageDown | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY111 `pane:top` | [键位:432](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Home | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY112 `pane:bottom` | [键位:433](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 End | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY113 `pane:grow` | [键位:434](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Ctrl+X Left, Ctrl+X Up | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY114 `pane:shrink` | [键位:435](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Ctrl+X Right, Ctrl+X Down | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY115 `pane:close` | [键位:436](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 Ctrl+X X | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY116 `pane:next` | [键位:437](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY117 `pane:previous` | [键位:438](https://code.claude.com/docs/en/keybindings)；上下文见文档第 424 行；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY118 `settings:search` | [键位:448](https://code.claude.com/docs/en/keybindings)；Settings；默认 / | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY119 `settings:retry` | [键位:449](https://code.claude.com/docs/en/keybindings)；Settings；默认 R | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY120 `settings:fixUsage` | [键位:450](https://code.claude.com/docs/en/keybindings)；Settings；默认 F | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY121 `select:accept` | [键位:451](https://code.claude.com/docs/en/keybindings)；Settings；默认 Enter, Space | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY122 `confirm:no` | [键位:452](https://code.claude.com/docs/en/keybindings)；Settings；默认 Escape | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY123 `agents:switchView` | [键位:460](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+S | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY124 `agents:togglePin` | [键位:461](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+T | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY125 `agents:find` | [键位:462](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+F | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY126 `agents:rename` | [键位:463](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+R | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY127 `agents:previousGroup` | [键位:464](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+Up, Meta+Up | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY128 `agents:nextGroup` | [键位:465](https://code.claude.com/docs/en/keybindings)；Agents；默认 Ctrl+Down, Meta+Down | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY129 `voice:pushToTalk` | [键位:479](https://code.claude.com/docs/en/keybindings)；Chat；默认 Space | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY130 `scroll:lineUp` | [键位:487](https://code.claude.com/docs/en/keybindings)；Scroll；默认 `wheelup` | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY131 `scroll:lineDown` | [键位:488](https://code.claude.com/docs/en/keybindings)；Scroll；默认 `wheeldown` | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY132 `scroll:pageUp` | [键位:489](https://code.claude.com/docs/en/keybindings)；Scroll；默认 PageUp | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY133 `scroll:pageDown` | [键位:490](https://code.claude.com/docs/en/keybindings)；Scroll；默认 PageDown | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY134 `scroll:top` | [键位:491](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Ctrl+Home | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY135 `scroll:bottom` | [键位:492](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Ctrl+End | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY136 `scroll:halfPageUp` | [键位:493](https://code.claude.com/docs/en/keybindings)；Scroll；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY137 `scroll:halfPageDown` | [键位:494](https://code.claude.com/docs/en/keybindings)；Scroll；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY138 `scroll:fullPageUp` | [键位:495](https://code.claude.com/docs/en/keybindings)；Scroll；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY139 `scroll:fullPageDown` | [键位:496](https://code.claude.com/docs/en/keybindings)；Scroll；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY140 `selection:copy` | [键位:497](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Ctrl+Shift+C / Cmd+C | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY141 `selection:clear` | [键位:498](https://code.claude.com/docs/en/keybindings)；Scroll；默认 (unbound) | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY142 `selection:extendLeft` | [键位:499](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+Left | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY143 `selection:extendRight` | [键位:500](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+Right | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY144 `selection:extendUp` | [键位:501](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+Up | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY145 `selection:extendDown` | [键位:502](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+Down | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY146 `selection:extendLineStart` | [键位:503](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+Home | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
| CL-KEY147 `selection:extendLineEnd` | [键位:504](https://code.claude.com/docs/en/keybindings)；Scroll；默认 Shift+End | 同屏原生 TUI；在同屏原生 TUI 里用；沿用原生键位，不造第二套编辑器 | 来源已列；归属审计；不逐项执行验收 |
