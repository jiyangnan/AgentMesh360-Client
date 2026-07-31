# 模型供应商列表优先与 WorkBuddy 调研

更新时间：2026-07-31
状态：已完成
进度：100%

## 1. 本轮触发

Owner 在真实客户端中发现：

1. 模型供应商页默认先展示一整张新增表单，已经配置好的供应商被压到首屏以下；
2. 新增与管理没有页面层级，用户无法先回答“我已经配置了什么”；
3. 已保存列表使用 7–11px 小字号，字体和其他页面不统一；
4. 需要实际调研本机 WorkBuddy 的产品架构、页面结构与功能分布，再决定 AgentMesh360
   应借鉴什么；
5. 现有测试曾把“表单默认出现”写成正确合同，存在测试固化错误设计的问题。

## 2. 方向复核

本轮继续遵守既定产品计划：

- Provider 页只管理模型供应商、Key、动态模型和连接状态；
- 每个 Agent 使用哪个 Provider/模型继续属于具体 Agent 的“模型”页；
- 不新增自动 fallback、价格/余额、在线商店、P7/P8、Apple 签名/公证或在线发布；
- 不改 Host/Harness 进程架构；
- 不调用真实 Provider，不读取真实 Key，不消耗 AgentMesh credits。

这是一轮既定信息架构的纠偏与补测，不是新产品范围。

## 3. WorkBuddy 直接观察

本机观察对象：

- WorkBuddy 5.3.8；
- `/Applications/WorkBuddy.app`。

可确认的结构：

- 一级导航为新建任务、助理、项目、专家·技能·连接器、自动化和更多；
- 主工作区以导航/最近任务、当前对话、上下文或产物分区；
- “专家·技能·连接器”内部继续分专家、技能和连接器三个局部页签；
- 专家页先展示搜索、我的专家、场景、分类和列表；
- 技能页先展示搜索与已安装列表，“添加技能”再分查找、上传和创建；
- 连接器页先展示连接器列表，用户选择后才进入连接配置；
- 管理页先回答“我已经有什么”，新增和编辑进入二级操作。

完整观察、未观察边界和 AgentMesh360 设计推导记录在：

`docs/research/WORKBUDDY_INFORMATION_ARCHITECTURE_AND_AGENTMESH360_LEARNINGS.md`

## 4. 实现合同

### 4.1 默认页面

- 打开“模型供应商”后直接展示“已配置的模型供应商”；
- 首屏唯一主行动为“配置新供应商”；
- 零供应商仍显示同一列表容器内的空状态和“配置第一个供应商”；
- 协议、URL 和三档检查默认收进“连接详情与诊断”。

### 4.2 新增与编辑

- 新增和编辑复用同一个 `role="dialog"` 模态窗口；
- Escape、关闭按钮、暂时关闭和遮罩关闭保留当前临时草稿；
- “放弃更改”和换账号清空草稿；
- 打开后焦点进入弹窗，Tab 不逃出，关闭后焦点返回触发按钮；
- 保存成功关闭弹窗并刷新列表；
- 保存失败保留 Key、模型、名称和已测试状态，允许原地重试。

### 4.3 删除

- 删除使用应用内确认弹窗，不使用系统 `window.confirm`；
- 显示供应商名称和受影响 Agent；
- 取消不调用 Host；
- 删除失败保留列表并给出可重试错误；
- 删除成功刷新列表和 Agent 模型失效状态。

### 4.4 视觉基线

- 新增全局 UI/代码字体、字号、控件高度、圆角和间距 token；
- Provider 名称 16px、状态 13px、元信息 13px、操作 13px；
- 机器标识才使用等宽字体；
- 建立 `docs/design/DESIGN_SYSTEM.md`，明确 Provider 是首个迁移模块，其他旧页面以后按
  产品计划逐模块迁移。

## 5. 测试合同

新增或修正的真实交互覆盖：

- 默认列表优先、一个/两个/零供应商；
- 主按钮打开配置弹窗；
- Escape、关闭、草稿恢复、放弃和账号隔离；
- 动态模型发现、连接测试和真实保存按钮；
- 创建失败保留 Key/模型/状态并直接重试；
- 编辑预填、暂时关闭、放弃和保存；
- 删除影响、取消、成功、失败和零 Agent 影响；
- Probe 默认折叠并可展开执行；
- snapshot 认证错误与重试恢复；
- 关键字号、字体族和 1180×760 视觉快照；
- installed acceptance 默认先验证列表，再主动打开弹窗。

产品旅程新增 `TC-PROVIDER-012` 和 `TC-PROVIDER-013`，总数从 63 条增加到 65 条。

## 6. 当前验证

- Desktop syntax：通过；
- Desktop Node：129 passed / 3 个显式 real-Host gate skipped / 0 failed；
- Provider、Agent 管理、Conversation、添加 Agent 四组 Electron smoke：通过；
- 产品旅程：65 条、14 个领域通过；校验器单元测试 3 passed；
- 视觉快照：
  - `/private/tmp/agentmesh360-provider-list-redesign.png`
  - `/private/tmp/agentmesh360-provider-dialog-redesign.png`
- KimiCLI 0.26.0 使用已配置的 Coding Highspeed 模型完成独立审查和交叉测试；
  唯一 P2 是弹窗 eyebrow 仍为 10px，已改为 `--text-caption` 12px；
  最终复验结论为 P0/P1/P2 全部清零、无阻断问题。

测试只使用本机 fixture 和 loopback，没有真实 Provider 请求、真实 Key、AgentMesh
credits、外部上传或费用。

## 7. 最终交付

- 功能 commit：
  `697310e234776a76cfdf3a9431ab84dd781cffb0`，已推送 `origin/main`；
- receipt：`desktop_internal_p6_697310e23477_arm64`；
- Desktop `0.1.1`，Host runtime
  `1000.1.1785482324001 (697310e)`；
- DMG：
  `183e76bfd9f1b014637e8c03a2a6b421b30b749915e924fb20b485d15b2aa727`；
- ZIP：
  `bbe33d56b4b8f3158ea97bb0fee6f9f620307fbd402f784aad1313f7540cdeb5`；
- receipt、双摘要、ZIP CRC、`hdiutil verify`、DMG 只读挂载、Host 架构与版本、
  `app.asar`/`Info.plist` inventory 以及构建/交付副本逐字节比较全部通过；
- 独立测试 Agent 再次只读复验，结果无阻断；内部 receipt 的最低系统版本仍使用
  `not_frozen_for_internal`，实际 `Info.plist` 为 macOS 12.0，公开发布前再统一冻结；
- 本地交付目录：
  `~/Downloads/AgentMesh360-Internal-Test-2026-07-31-697310e-arm64/`；
- 新包验证通过后才删除上一包与旧构建证据；Downloads 和
  `desktop/dist/internal` 各只保留一份，仓库根 `target/` 已删除；两个更早版本残留
  的只读 DMG 卷确认无进程使用后也已安全卸载；
- Provider 请求、真实 Key、AgentMesh credits、Apple 服务请求、外部上传和费用均为
  0。

## 8. 下一轮

本轮关闭后，下一产品切片仍回到既定首次使用引导，不把 Provider 路由重新塞回供应商页，
也不扩展自动 fallback、价格/余额、在线商店、P7/P8 或生产发布。
