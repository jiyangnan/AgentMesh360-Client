# Agent 工作区对话与会话导航重构

状态：功能、全量回归与 KimiCLI 终审通过，内部交付进行中

日期：2026-07-31

## 1. 用户问题

当前 Agent 详情页把 Agent 介绍、模型摘要、运行状态、四个页签和 Conversation 自己的
标题同时放在首屏，导致同一个 Job Agent 被重复介绍两次，对话、模型、`agent.md` 和
`user.md` 处于错误的同级视觉层次。消息正文、辅助文字和输入框字号偏小，正文又横跨
大屏，阅读和定位都很困难。

用户期望的心智是：

1. 全局左侧导航负责 Agent、模型供应商和客户端设置；
2. 进入持久 Agent 后出现二级侧栏，上半区选择持久 Agent，下半区选择该 Agent 的会话；
3. 主区域默认且只突出对话；
4. 模型、行为 `agent.md` 和偏好 `user.md` 收进右上角齿轮设置，不与对话并列；
5. 对话使用清楚、适合长时间阅读的字号、行宽和固定输入区。

## 2. 既有合同与本轮边界

- 当前每个账户、每个产品 Agent 只有一个 Host Registry 指定的确定性 Main Session；
- 本轮子导航只展示 Host 当前真实拥有的会话，因此当前列表为“主会话”一项，不伪造
  多会话、不读取本地目录猜测会话；
- 子导航和 Renderer 数据结构按列表实现，为未来 Host 提供账户隔离的会话索引后保留
  扩展位置；
- 不新增会话创建、重命名、删除、搜索或归档；
- 不改变 Session ID、Workspace、Provider Binding、对话历史、overlay 和安全投影合同；
- 不扩展 Provider、价格、credits、在线商店、P7/P8、Apple 签名/公证或生产发布。

## 3. 实施方案

### 3.1 三栏工作区

- 第一栏：既有全局导航；
- 第二栏：上方为常驻 Agent，下方为当前 Agent 的会话；
- 第三栏：对话或 Agent 设置；
- 未激活 Agent 仍从 Agent 列表进入激活设置，不显示伪造的会话列表。

### 3.2 对话默认页

- 删除重复的 Agent 详情头和 Conversation 返回头；
- 使用单一紧凑工具栏显示 Agent 名、当前会话、连接状态和齿轮；
- 对话正文限定阅读宽度，正文不低于 15px，消息标签和关键状态不低于 12px；
- Composer 固定在主区域底部，输入文字不低于 15px；
- 保留项目、计划、后台任务、活动、产物、权限确认、草稿和错误恢复合同。

### 3.3 Agent 设置

- 齿轮进入独立 Agent 设置视图；
- 设置内提供“模型”“行为”“用户偏好”三个二级项；
- 设置页提供明确“返回主会话”；
- 生成中继续锁定设置，模型失效时仍从 Conversation 错误行动直达模型设置；
- 未保存草稿、revision 冲突和账号隔离行为不变。

## 4. 测试计划

1. Electron Conversation smoke：默认纯对话、二级侧栏、Agent 切换、主会话选择、草稿、
   发送、错误和权限确认；
2. Electron Agent 管理 smoke：齿轮进入设置、三个设置项、返回对话、未激活 Agent、模型
   保存失败恢复、overlay 冲突、Turn 锁定和账号切换；
3. 计算样式：三栏宽度、正文/输入字号、消息阅读宽度、44px 齿轮点击目标；
4. 1180×760 和宽屏视觉截图；
5. Desktop Node、四组 Electron smoke、产品旅程结构与执行校验、Repository 工具链；
6. KimiCLI 只读复核完整 diff、交互覆盖和视觉层级；发现问题后修复并重复复核，直到
   P0/P1/P2 清零；
7. 最终覆盖安装不发送真实消息、不读取 Provider Key、不请求 Provider、不消耗 credits。

## 5. 完成门槛

- 对话是持久 Agent 的默认且唯一主视觉任务；
- 首屏不存在模型、`agent.md`、`user.md` 与对话并列的页签；
- 二级侧栏能在已激活 Agent 与真实会话之间导航；
- 设置入口、返回路径、错误修复和生成中锁定都有点击级回归；
- 全量测试、KimiCLI、安装包验收和单包清理通过；
- `PROJECT_PROGRESS.md`、信息架构、设计基线和测试用例同步更新。

## 6. 实施与终审结果

- 三栏工作区、纯对话默认页、齿轮设置、单一真实主会话、15px 阅读列和固定 Composer
  已按本计划实现；未增加任何伪造的多会话能力；
- Conversation Electron 回归覆盖 delayed A→B latest-intent、旧 response/push 隔离、
  send 提交瞬时锁定、当前 Agent/主会话只复用 Renderer、账号/Agent/Main Session 草稿
  隔离，以及发送失败恢复；
- Agent 管理 Electron 回归覆盖模型与 overlay 延迟成功、失败、revision 冲突到达另一个
  Agent 后的归属隔离；
- KimiCLI 首轮终审发现 send pending 时 Host 让位产生无 Agent `idle` 快照可能留下永久
  turn lock，以及关键状态仍为 11px；两项均已修复；
- 修复后成功与失败两条 send IPC 都在 pending 窗口注入 `idle` 快照并真实点击复验；
  `.conversation-state` 和 Composer 关键提示统一为 12px 并增加计算样式断言；
- KimiCLI 复跑 Desktop syntax、Conversation、Agent 管理和 73 条产品旅程后最终结论
  `CLEAN`，P0/P1/P2 为 0；下一步只做既定唯一 unsigned internal 包和覆盖安装验收。
