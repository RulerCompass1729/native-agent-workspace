# 许可、署名与商业化准备

As of 2026-10-17。本文件是对已读取条款的工程核查与选择记录，不表示所有未来依赖已清查完毕。

## 当前决定

创始人于 2026-10-17 确认采用标准 **Apache-2.0**。除另有说明外，本仓库原创内容按未改写的 [LICENSE](../LICENSE) 授权；[COPYRIGHT](../COPYRIGHT) 记录版权与适用范围，[NOTICE](../NOTICE) 记录项目归属。

独立产品仓库；不搬运竞品实现、品牌素材或 provider 二进制。本地源码 demo 通过 npm 依赖固定版本 DSH；未复制其完整源码或发布二进制安装包。本项目的许可不替代任何第三方材料、服务或品牌的原有条款。

创始人的目标是保留自己商用的可能性、尽可能保留贡献与归属，同时扩大产品影响力。public 可见性本身不回答是否允许别人复制、修改和商用。公开 GitHub 仓库仍受平台允许查看和 fork 等条款约束。[GitHub 的说明](https://choosealicense.com/no-permission/)

## 已选许可的作用与取舍

**Apache-2.0** 允许自己商业化，也允许他人商业使用；分发者需满足许可、修改说明及相关归属保留要求；有明确的贡献者专利授权条款。项目使用标准 LICENSE，配套真实的版权/NOTICE 与贡献记录，不附加禁止商用或强制首页展示品牌的限制。[完整条款，尤其第 2–4、6 节](https://www.apache.org/licenses/LICENSE-2.0)

需要接受的取舍：它不禁止合法商业竞争、闭源衍生产品，也不要求在每个产品首页展示原作者广告。NOTICE 只记录归属，不能借此添加不属于标准许可证的额外限制。版权不因开源消失，但已依法授出的开放使用权不能靠以后删除仓库收回。

MIT 同样允许商业使用并要求保留版权/许可通知，更简洁；Apache-2.0 的明确专利和修改声明条款是推荐它的原因，不是 MIT 不能保护署名。

若真正目标是“修改版必须按条件提供源码”，可以另评估 GPL/AGPL 类许可；这些仍允许商业使用和竞争，不能等同于禁止别人赚钱。若目标是禁止竞争性分发，则属于另一类 source-available/商业许可选择，不能再把该限制说成标准 Apache-2.0 开源。[GNU AGPL 官方条款](https://www.gnu.org/licenses/agpl-3.0.html)

双重许可涉及是否拥有相关贡献的再许可权，不能假设以后收了外部 PR 就可随意换许可。按 Apache-2.0 第 5 节，主动提交用于纳入项目的原创贡献默认采用相同条款，明确另行声明的情况需先审查。贡献者保留各自版权，本阶段不要求版权转让或单独 CLA，也不接收许可不明的代码。详见 [CONTRIBUTING](../CONTRIBUTING.md)。

产品名称、logo、官方分发与后续服务可形成独立价值；Apache-2.0 不一般性授予商标使用权。收费模式不在本轮定案，不凭一个许可证承诺商业成功。

## 上游与 provider 的实际边界

| 对象 | 核查结论 | 本项目采用时的动作 |
| --- | --- | --- |
| DSH 自身源码 | 所读 commit 顶层 MIT；允许商用修改与分发，需保留版权和许可 | 记录 commit、路径、修改与完整 MIT 文本；不把上游代码改署名为本项目原创 |
| DSH 品牌 | 独立品牌规范允许如实描述关系，避免直接以完整官方品牌命名或暗示背书 | 用自己的产品名；仅真实描述兼容/依赖关系；不复制官方 logo |
| DSH 完整依赖 | THIRD_PARTY_NOTICES 列出不同许可；不覆盖所有传递依赖结论 | 对最终实际分发 closure 重新核查，不以顶层 MIT 代替 |
| Claude Agent SDK | 官方 README 指向 Anthropic 商业条款，不能把其 MIT wrapper 视作 SDK 的许可 | 本产品完整 Teams 不采用 SDK 作为默认主会话；将来引入时单独核条款与登录路径 |
| Claude Code | 专有条款；当前官方文档允许在规定条件下于产品中运行未修改二进制 | 保持未修改的原生 CLI、原生登录与用户直接计费；不收集/转存账号 token，不代理或转售用户用量 |
| Codex | 官方仓库 Apache-2.0；模型服务和品牌并非由源码许可证一并授权 | 复用源码/分发时保留适用 LICENSE、NOTICE 与修改说明；服务认证遵循官方机制 |
| Orca / Nimbalyst | 所读顶层 MIT | 当前仅参考；选定具体代码后再逐项保留来源与检查依赖 |
| cmux / Maestro / Superset | 各有 GPL、AGPL 或其他条款，不能概称宽松开源 | 当前不引入其实现；如以后需要，先按实际组合与分发方式判断义务 |
| Backchat / 闭源应用 | 整体授权未确认或应用不公开 | 不复制代码和产品素材；公开可见不等于授权复用 |

### DSH 必须补看的部分已发现

在所读版本，第三方清单包括 Claude SDK/平台 payload 的专有条款、LibreOffice kit 的 MPL-2.0 以及开发工具各自的许可。它明确说清单主要覆盖直接依赖及指定 payload，传递依赖要看 lockfile。该仓库“project owner authorizes distribution”的表述是其项目内的决定，**不是 Anthropic 对本项目的单独授权证明**。

这不意味着 DSH 不能用于商业产品；意味着要按实际选用内容承担相应义务。不能把“fork 按钮可用”当作完整分发许可检查。

### Claude 原生接入与 SDK 登录不能混为一谈

官方当前说明：托管原版 Claude Code 有条件允许；原生二进制的认证方法不能被删除、限制或代替，用户使用自己的凭据并直接承担用量。第三方应用不得自建 Claude.ai 登录或收集、中转其会话 token；SDK 产品的认证要求另有约束。因此优先保留未修改 native CLI 与原生登录，不能偷偷把登录凭据拿给另一条 SDK 路径。[当前官方条款说明](https://code.claude.com/docs/en/legal-and-compliance)

本阶段不重新分发 provider 二进制。正式提供下载、收费或捆绑 runtime 时，需对实际版本及交付方式复核，完成适用条款接受与许可通知。不是因为代码放在不同进程就自动免除条款。

## 开始复制代码或发布安装包时才执行

记录实际引入文件、版本、源地址、许可、版权人、修改和发行位置。依赖树/字体/图标/办公引擎/本机二进制分别检查，生成实际发行物的 notices；需要提供对应源码时准备可访问的版本。保留上游来源不等于把全部 upstream 源码复制进本仓库。

不混入私人调研、会话、凭据或本机路径。每次公开提交与推送前仍执行 secret 与 PII 检查。

## 已引入的试验工具依赖

原生连续性探针仅声明 `websockets==16.0`，作为开发试验工具，不是桌面产品 runtime。已读取安装包的完整 BSD-3-Clause 许可，版权人为 Aymeric Augustin and contributors；未复制其源码或二进制入仓库。未来分发含该包的产物时保留对应版权、条件与免责声明。[上游许可](https://github.com/python-websockets/websockets/blob/16.0/LICENSE)

探针只通过该包连接用户明确指定的本机 Unix socket，不读取认证文件或上传报告；原生 Codex 的认证、模型服务与网络行为仍归原生机制。这不替代未来桌面分发的完整依赖及隐私检查。

## 证据

- [DSH MIT](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)
- [DSH 品牌规范](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/BRAND_GUIDELINES.md)
- [DSH 第三方清单](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/THIRD_PARTY_NOTICES.md)
- [Claude Code LICENSE](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)、[SDK 条款](https://github.com/anthropics/claude-agent-sdk-typescript#license-and-terms)
- [Codex LICENSE](https://github.com/openai/codex/blob/main/LICENSE)

动态官方条款与未固定版本的链接会变化；所有推荐在引入或发行时重查。尚未完成完整依赖树审计、最终商标检索或第三方素材授权；当前仅公开原创接入源码与依赖锁文件，不把待查的完整二进制发行范围记成通过。

## 本地桌面 demo 的依赖范围

固定版本见 package-lock.json：DSH 0.2.1-rc.2、xterm/headless 6.0.0、fit 0.11.0、serialize 0.14.0、ws 8.22.0、Electron 44.9.0、Playwright 1.64.1。已读取直接使用包的许可；DSH/xterm/ws/Electron 为 MIT，Playwright 为 Apache-2.0。依赖保持原发行内容，不改原署名。

UI 构建将 xterm 和 fit 的完整 MIT 通知放入本地生成 bundle。运行服务复制 xterm headless/serialize 时补入其 npm 文件清单遗漏的上游完整 MIT 通知；核对来源为 [xterm.js 固定源码 LICENSE](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/LICENSE)。ws 自带许可随目录复制保留。生成文件、node_modules 和原生 provider 二进制不进公开 Git。

DSH 的传递依赖仍含 MPL/LGPL 等不同条款；这里没有把 691 个锁文件 package 条目逐项认证为可直接打包。正式安装包、自动更新与二进制再分发尚未提供，需按实际发行内容完成对应 notices/source 等义务。源码 demo 不能被描述为已完成全部商业发行法律审计。
