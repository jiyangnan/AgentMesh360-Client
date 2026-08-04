# Agent 首页三步引导层级修正

状态：已完成

日期：2026-08-02

## 1. 用户问题

Agent 首页引导卡把动态文案“打开 Agent 继续工作”作为标题展示，视觉上像一个可点击入口，
但当前状态下它并不是按钮。真正需要用户理解的“添加模型供应商 → 激活 Agent → 开始对话”
反而字号很小、层级很低，不能清楚表达三步必须按序完成。

## 2. 本轮范围

1. 删除首页引导卡中的“开始使用”和动态下一步标题；
2. 把“添加模型供应商、激活 Agent、在 Agent 对话中开始工作”改为卡片唯一主内容；
3. 使用语义化有序列表、清晰步骤编号和连续关系表达顺序，同时保持整卡为纯提示而非伪按钮；
4. 补齐 DOM、字号、顺序、无交互控件和常用窗口宽度的 Electron 回归；
5. 完成 KimiCLI 独立复核、进展文档、clean push、唯一内部包和安装验收。

## 3. 非目标

- 不改变 Provider、Agent 激活或对话的业务流程；
- 不新增点击跳转、进度持久化、完成态或新手引导弹窗；
- 不修改 Agent 卡片、三栏工作区、模型设置或会话结构；
- 不发送消息、不读取 Provider Key、不请求 Provider、不消耗 credits；
- 不做签名、公证或在线发布。

## 4. 完成门槛

- 首页不再出现“开始使用”和“打开 Agent 继续工作”；
- 卡片只展示三个按序步骤，DOM 为 `ol > li`，且内部没有按钮或链接；
- 三个步骤为主要字号和视觉层级，在 1180×760、1280×800 与宽屏无溢出；
- 自主回归与 KimiCLI 均无 P0/P1/P2；
- 新包通过后再删除上一包，Downloads 与 `desktop/dist/internal` 最终各只保留一份。

## 5. 当前执行结果

- 已删除动态标题、`data-go-view` 入口及 Agent 首页对 Provider 快照的无效预取；三步提示改为
  固定的 `section[aria-label="Agent 使用顺序"] > ol > li`，卡内交互元素为 0；
- 自主回归通过：语法检查；147 项 Node 测试中 142 通过、5 项真实 Host 用例按环境显式
  跳过、0 失败；Agent 管理 Electron 烟测；1180×760 与 1280×800 两个 ready 视觉烟测；
  74 个产品旅程用例、14 个领域校验；
- KimiCLI 0.26.0 完整 diff 只读复核与独立复跑结论为 `CLEAN`，无 P0/P1/P2；另一只读
  审查 Agent 结论同为 `CLEAN`；
- 测试全程使用 fixture，未发送消息、未调用真实 Provider、未消耗 credits、未改变已安装
  客户端状态；
- 功能 commit `9f2712c9b6c7791da002e0822c8fe9e49611edf0` 已 clean push。arm64 内部包回执
  `desktop_internal_p6_9f2712c9b6c7_arm64` 通过，DMG SHA-256 为
  `4b93516fb10a44c6689fb769f39e73b32015a0fe98a03f47f28a3a0c9250527b`，ZIP
  SHA-256 为 `deb600a2f44d25c6644b7e367811bf222d740cb3b76a158c537e27508d9b7660`；
- 新包通过 SHA-256、`hdiutil verify`、ZIP CRC、来源/Downloads `cmp` 和 arm64 Host
  `--version` 复验。真实安装验收恢复有效账号、订阅、1 个常驻 Agent、10 个官方 Provider
  预设及可用主会话，`agentHomeOrderedGuide=true`；消息、Provider 请求和 credits 均为 0，
  临时草稿已清空；
- 客户端已关闭临时调试端口并按普通方式重新打开。旧构建、旧 Downloads 包及安装备份已
  清理；`desktop/dist/internal` 与 Downloads 目前各仅保留本轮一份包。

## 6. 后续合同替代说明

2026-08-05 的“首次使用引导”独立切片已经承接本计划当时明确留下的后续工作。这里记录的
“纯提示、零按钮、无进度态”只代表 2026-08-02 当轮交付事实，不再是当前产品合同；当前合同
以 `260805_首次使用引导_proposal.md`、`DESIGN_SYSTEM.md` 第 8 节和 `TC-GUIDE-001～002`
为准。三步顺序不变，但未完成用户会看到 Host 权威状态和唯一真实下一步，正常回访用户首页
不再重复显示新手卡。
