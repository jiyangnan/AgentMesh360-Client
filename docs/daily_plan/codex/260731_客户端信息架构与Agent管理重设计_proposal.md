# 客户端信息架构与 Agent 管理重设计

更新时间：2026-07-31
状态：已完成
进度：100%

## 1. 本轮目标

重新设计 AgentMesh360 Client 的左侧导航、一级页面职责、页面内信息层级、子菜单与
首次使用路径，解决当前 Provider 设置页混入 Agent 模型路由、内部技术术语直接暴露、
用户不知道下一步做什么等问题。

本轮先完成产品交互合同和逐控件测试用例，再实现；不在设计未收敛前直接移动组件。

## 2. 产品不可改变的边界

1. 客户端只有有效 AgentMesh360 订阅才能进入；BYOK 是默认 Provider 模式。
2. 用户电脑上只有一个持久 Grok Build Host/Harness；Job、LectureCast、Deploy 和未来
   Agent 是持久产品身份与固定 Main Session，不各自复制完整进程。
3. Provider Key 只交给本机 Host Vault，Renderer 和 Agent 都不能读回。
4. Provider 设置只负责接入、测试、保存、编辑和删除模型供应商。
5. 每个 Agent 使用哪个 Provider/模型、是否激活、Agent 自身说明与用户偏好，属于
   Agent 管理，不属于 Provider 设置。
6. Agent Package 负责 Agent 的安装、更新、权限预览与可信来源；不能与“管理已安装
   Agent”混成同一职责。
7. 普通用户首先完成“接入 Provider → 激活 Agent → 开始对话”；内部的 role、
   Assignment、Binding、revision、Host Authority 等术语不能成为主路径门槛。
8. 已有会话、账户状态、Provider 草稿和对话草稿在切页、窗口隐藏、后台复验与 Host
   版本接管时不能丢失。
9. 当前是 unsigned internal macOS 包；不扩展 Apple Developer ID、公证、在线发布、
   自动 fallback、Provider 价格或余额。

## 3. 当前界面事实

左侧一级菜单目前是：

1. 常驻 Agent
2. 当前对话
3. Agent Package
4. Provider 设置
5. 客户端设置

当前“常驻 Agent”页是三列 Agent 卡片，只提供“激活并打开/打开对话”。

当前 Provider 设置页同时包含：

- 新建/编辑 Provider、动态模型发现、测试连接、安全保存；
- 已连接 Provider 与三档 Probe；
- Global/Agent Assignment；
- Provider/模型路由矩阵。

底层支持 `Session > Agent > Global` 和多个推理 role，但桌面 UI 只提供 Global/Agent，
模型输入又合并所有 Profile 与内置 Catalog 的模型；这会产生错误用户心智和
Provider/模型错配风险。

## 4. Owner 已确认的产品方向

1. Provider 设置页只配置模型供应商。
2. 独立的 Agent 管理负责：
   - 查看 Agent 状态；
   - 激活新的 Agent；
   - 打开持久对话；
   - 为单个 Agent 选择或更换 Provider 和模型；
   - 管理与该 Agent 相关的 `agent.md`；
   - 管理与该 Agent 相关的 `user.md` 用户偏好；
   - 后续承载其他具体 Agent 设置。
3. 需要系统审查左侧导航是否符合用户心智，每个菜单的页面结构是否合理，是否需要
   新增菜单或子菜单。
4. 需要与 KimiCLI 讨论设计；必须回答它的不清楚问题，不能把含糊假设直接做成 UI。

## 5. 需要 KimiCLI 第一轮回答

KimiCLI 需要基于本文件和真实代码做只读审查，回答：

1. 当前五个一级菜单对首次用户和长期用户分别会形成什么心智？哪些名称、顺序或层级
   不合理？
2. 推荐的一级导航、二级导航和页面地图是什么？为什么？
3. “首页/Agent 列表/Agent 详情/当前对话”的关系应如何设计，避免重复入口和迷路？
4. Provider 设置页应保留哪些功能、移除哪些功能、采用什么结构？
5. Agent 管理列表和详情页应有哪些区块、状态、主要按钮和危险操作？
6. Agent Provider/模型选择如何做到动态、可理解、不会错配，并处理未配置 Provider、
   Provider 被删除、模型失效和已有 Session 路由变更？
7. `agent.md` 与 `user.md` 应如何解释、编辑、保存、恢复默认、控制生效时机，并避免
   用户破坏 Agent Package 的签名基础定义？
8. Agent Package 页应该叫“Agent Package”“Agent 商店”“添加 Agent”还是其他？
   当前尚无生产远端商店时如何避免虚假承诺？
9. 客户端设置、账户/订阅、后台 Host 状态和高级诊断应放在哪里？
10. 新用户从登录后到第一次成功对话，以及老用户恢复上次工作的完整流程是什么？
11. 哪些技术能力应该隐藏到高级设置？哪些错误、空状态、加载状态和草稿状态必须明确？
12. 给出可以直接转成逐控件测试的交互合同和最小页面线框说明。
13. 明确列出所有仍需 Owner/实现方回答的问题；不要自行填补会改变产品方向的假设。

## 6. KimiCLI 可读代码入口

- `desktop/src/ui/app.js`
- `desktop/src/ui/style.css`
- `desktop/tests/provider-ui-smoke.js`
- `desktop/tests/conversation-ui-smoke.js`
- `desktop/tests/package-ui-smoke.js`
- `desktop/src/provider-controller.js`
- `crates/codegen/xai-grok-shell/src/agentmesh360/model_assignments.rs`
- `crates/codegen/xai-grok-shell/src/agentmesh360/model_routing.rs`
- `crates/codegen/xai-grok-shell/src/agentmesh360/registry.rs`
- `docs/architecture/PRODUCT_BLUEPRINT.md`
- `docs/architecture/PERSISTENT_PRODUCT_AGENTS.md`
- `docs/test-cases/test-cases.md`

KimiCLI 不得读取或输出真实账号、Key、Token、Keychain、Vault、用户对话、用户目录状态或
构建包内容；不得修改代码、文档、Git、系统设置或外部服务。

## 7. 完成门

1. KimiCLI 第一轮审查完成并列出疑问；
2. 主 Agent 逐条回答并要求 KimiCLI 修订；
3. 最终导航与页面职责没有未解释冲突；
4. 每个可交互控件都有输入、状态、预期输出、错误恢复和测试编号；
5. 计划与项目进展更新后才开始实现；
6. 实现完成后执行 Node、Electron、Rust、真实安装客户端和 KimiCLI 交叉测试；
7. 新包通过后删除旧包，始终只保留一个内部测试包。

## 8. KimiCLI 三轮联合评审结论

KimiCLI 0.26.0 已在不读取账号、Key、Vault、对话和构建包的前提下完成三轮只读
源码审查：

1. 第一轮审查当前五项一级导航与真实页面实现，指出“常驻”“当前对话”
   “Agent Package”均把内部概念当成用户心智，Provider 页同时承担供应商接入与
   Agent 路由，客户端设置也与实际后台 Host 内容不匹配；
2. 主 Agent 逐项回答是否保留对话、Provider 层级、默认落点、危险操作、Host 指示、
   Package 命名、激活默认值和引导恢复等九个问题；
3. 第二轮给出 Provider、Agent 列表、Agent 详情、模型绑定和覆盖层逐控件合同；
4. 主 Agent继续回答 user.md 作用域、Host 接口、并发冲突、长度与秘密边界、迁移、
   needs_input 语义和远端不可用展示等八个问题；
5. 第三轮压力测试独立首页的必要性，最终确认只保留 Agent、模型供应商、设置三个
   一级入口；Agent 列表直接承担默认落点、引导和恢复工作，避免重复页面和假摘要；
6. 最终导航、页面地图、状态机与实现边界已固化到
   `docs/architecture/CLIENT_INFORMATION_ARCHITECTURE_V1.md`；
7. KimiCLI 最终结论为“无阻断问题”。

## 9. 执行顺序

1. Host 按 Agent 的模型绑定与覆盖层数据层；
2. Provider 页移除 Assignment/路由矩阵；
3. 三入口导航、Agent 默认页与 Host 三态；
4. Agent 详情、对话迁入与激活确认；
5. 模型切换；
6. agent.md/user.md 编辑器；
7. 添加 Agent 与设置重组；
8. Node、Electron、Rust、真实安装客户端和 KimiCLI 交叉测试。

## 10. 测试合同落地

`docs/test-cases/test-cases.md` 已由 45 条、9 个领域扩展为 62 条、14 个领域，新增：

- 三项顶级导航、Host 三态和首次使用引导；
- Agent 激活确认与无 Provider 阻断；
- Agent 级 Profile/模型级联、下一条消息生效、失效恢复和旧路由迁移；
- `agent.md` / `user.md` 保存、草稿、恢复默认、秘密拒绝与并发 revision；
- Provider 页面职责边界；
- “添加 Agent”页面用户语言；
- 设置页四类子菜单。

旧 `TC-PROVIDER-009` 把桌面未完整提供的 Global/Agent/Session 路由写成“已实现、通过”，
现已纠正为 Agent 级交互迁移合同和“待执行”。测试校验器同步要求 14 个领域，
当前结构校验为 62/62 通过；实现完成前不会把计划用例提前标成通过。

## 11. 实现结果

1. 一级导航已收敛为“Agent / 模型供应商 / 设置”，登录后默认进入 Agent；
2. Agent 卡片显示当前供应商、模型和失效状态；已激活 Agent 打开固定对话，未激活
   Agent 在详情内完成权限确认、供应商和模型选择后激活；
3. Agent 详情已提供“对话 / 模型 / 行为 agent.md / 偏好 user.md”四个页签；
4. Provider 页面已移除 Role、Scope、Assignment 和路由矩阵，只负责供应商接入、
   实时模型发现、连接测试、保存、编辑、删除和检查；
5. Host 新增账户+Agent 级 overlay、8000 Unicode 字符、明显秘密拒绝、乐观 revision
   和下一条消息前 Prompt 重建；
6. 模型 Assignment 只接受当前 Profile `enabledModels` 内的模型；切换失败会恢复原
   Agent Assignment，不静默 fallback；
7. 窗口切换、Provider 页面往返、后台订阅复验和 Host 状态刷新不清空草稿；账号切换
   清除 Renderer 草稿；
8. Host 状态使用“已连接 / 正在恢复 / 需要处理”三态，点击进入“设置 > 后台运行”；
9. 删除 Provider 前列出受影响 Agent，确认后立即显示修复入口且保留对话历史；
10. 重启自动恢复对话时同步加载 Agent 管理快照，绑定失效会立即禁发并提示重选模型。

## 12. 联合复核与当前完成门

KimiCLI 在三轮信息架构评审后，又完成三轮实现/安全/测试审查和一次最终复验。其最终
结论为“无阻断问题”。最终复验前提出的 Host 三态、删除影响、草稿、user.md、revision
冲突、零/单 Provider、生成中锁定、8000 字符正边界和模型回滚均已进入自动化；最终
仅提出三个 P2 观察，其中重启恢复绑定失效、冲突放弃路径和账号切换草稿隔离也已在
本轮继续补齐。

当前回归证据：

- Desktop Node：129 passed / 3 个显式 real-Host gate skipped / 0 failed；
- Electron：Agent 管理、对话、Provider、添加 Agent 四组 smoke 全部通过；
- AgentMesh360 Rust：202 passed / 1 个显式外部源码 checkout ignored / 0 failed；
- Clippy `-D warnings`、Rust fmt、Desktop syntax、产品旅程 62/14 结构校验与校验器
  3 条单元测试全部通过；
- 没有读取真实 Key、发起 Provider 请求、消耗 AgentMesh credits 或产生外部费用。

最终交付证据：

- 功能 commit `461f1af9ab8c981e21669b4b00da2e3d1d7b9373` 已推送
  `origin/main`；
- 从该 clean pushed commit 构建 arm64 unsigned internal DMG/ZIP，receipt
  `desktop_internal_p6_461f1af9ab8c_arm64` 通过；
- DMG SHA-256：
  `338323b23311a6765150d100069dee6c2ba9ac5abbf0dd336b96ddbadad1d2ea`；
- ZIP SHA-256：
  `46070c7528411e7ec403372cc2bbad62f472e7163fb8e84846b2003776eb79d8`；
- receipt verifier、`SHA256SUMS`、`hdiutil verify`、构建/交付副本逐字节比较和 ZIP
  Host/`app.asar` inventory 全部通过；
- 新包验证后才删除上一份包和旧构建证据；Downloads 与
  `desktop/dist/internal` 各只保留当前一份，仓库根 `target/` 已删除；
- 当前本地交付目录：
  `~/Downloads/AgentMesh360-Internal-Test-2026-07-31-461f1af-arm64/`。

计划复盘：本轮只重构客户端信息架构、Agent 管理、Provider 职责和对应测试，没有进入
Provider 价格/余额、自动 fallback、在线商店、P7/P8、Apple Developer ID、公证或在线
发布。下一产品切片应从这套三入口结构继续既定计划，不能把已移除的模型路由重新塞回
模型供应商页。
