# 首次使用引导计划

状态：完成

日期：2026-08-05

## 1. 计划依据

- 总产品计划在 Job Agent `0.5.6` 真实猎聘 UAT 闭环后，明确要求下一独立切片回到首次使用引导；
- 当前 Agent 首页虽然固定展示“添加模型供应商 → 激活 Agent → 在 Agent 对话中开始工作”，
  但只是静态提示，不能告诉用户当前完成到哪一步，也不能直接执行真正的下一步；
- “设置 > 使用指南”又维护了一份独立静态说明，和首页当前进度不一致；
- 首页已有 `agent:get-model-overview` 安全投影。该调用已经读取 Provider Profile 与 Agent
  Assignment，因此可以在不额外读取 Key、不加载完整 Provider 页面快照的前提下，增加一个
  非秘密的已配置 Provider 数量，作为引导进度依据。

## 2. 本轮目标

1. 保留三步有序列表作为 Agent 首页的主要提示，但为每一步增加明确的“当前 / 已完成 / 待完成”状态；
2. 当前步骤必须提供真实按钮：去配置模型供应商、查看可激活 Agent，或打开一个已激活 Agent
   的主对话；不再让用户猜应该点击哪里；
3. “设置 > 使用指南”复用同一套状态和动作，用户离开或稍后回来仍能继续；
4. Provider、Agent 激活或账号状态改变后，通过现有 Host 权威快照重新计算进度，不新增
   Renderer 持久进度、不读取 API Key、不从界面字符串猜测；
5. 对已有模型正常常驻 Agent 的回访用户，首页隐藏新手卡；“设置 > 使用指南”仍可随时查看
   当前步骤和继续入口，不弹全屏引导、不遮挡对话、不自动跳页；
6. 修复激活失败被 Renderer 误判为成功的既有缺口：身份非 ready、存在激活错误，或目标
   没有同时进入 `desiredState=running` 与允许的常驻/启动运行态时，Main 必须拒绝 IPC，
   界面留在模型设置并允许重试。

## 3. 状态与交互合同

| 状态 | 第 1 步 | 第 2 步 | 第 3 步 | 当前真实动作 |
| --- | --- | --- | --- | --- |
| Overview 读取中 | 待确认 | 待确认 | 待确认 | 仅内联确认，不锁全屏 |
| Overview 失败 | 无猜测 | 无猜测 | 无猜测 | “重新确认进度” |
| 无已配置 Provider | 当前 | 待完成 | 待完成 | 打开“模型供应商”列表 |
| 有 Provider、无常驻 Agent | 已完成 | 当前 | 待完成 | 聚焦下方可激活 Agent |
| Provider 已配置、Agent 正在启动 | 已完成 | 当前 | 待完成 | 显示后台启动状态，仍可切换并查看其他 Agent |
| Provider 已配置、Agent Catalog 为空 | 已完成 | 当前 | 待完成 | 明确暂无 Agent，并重新读取 Host 权威目录 |
| 有 Provider、有正常常驻 Agent | 已完成 | 已完成 | 当前 | 首页隐藏；设置指南打开明确命名的正常 Agent |
| 正常与失效常驻 Agent 混合 | 已完成 | 已完成 | 当前 | 只打开正常 Agent，失效 Agent 保留修复提示 |
| 有常驻 Agent、Provider 已失效/删除 | 当前 | 已完成 | 待完成 | 先恢复模型供应商，不静默 fallback |

## 4. 影响范围

- `desktop/src/agent-management-controller.js`：在现有 Overview 安全投影中增加非秘密
  `configuredProviderCount`，只统计已配置凭据且至少有一个模型的 Profile，不返回 Profile
  内容或凭据；
- `desktop/src/background-startup.js`：激活返回后复核身份仍为 `ready`、没有激活错误，且目标
  Agent 同时处于 `desiredState=running` 与允许的常驻/启动运行态，否则 fail closed；
- `desktop/src/ui/app.js`：统一首页与设置指南的状态渲染、动作和失败恢复；
- `desktop/src/ui/style.css`：三步状态、真实 CTA、窄窗口和键盘焦点样式；
- `desktop/tests/`：控制器投影、四状态 Electron 流程、现有 Agent 管理和视觉回归；
- `docs/test-cases/test-cases.md`：更新 `TC-GUIDE-001` 并增加失败恢复用例。

## 5. 非目标

- 不新增首次引导弹窗、遮罩、轮播、账号级完成标记或遥测；
- 不改变登录、订阅、Provider 保存、Agent 激活、Main Session 或模型路由 authority；
- 不开放多会话、Agent 商店、Package 入口、自动 fallback、P7/P8、签名、公证或在线发布；
- 不调用真实 Provider、Job 服务或 AgentMesh360 Core，不消耗 credits 或产生费用；
- 按用户当前要求由本机代码与自动化自主复核，不使用 Kimi。

## 6. 验收门槛

- 三步顺序始终不变，每步状态和当前动作与 Host 权威数据一致；第三步只表示“可以开始或
  继续”，没有 Host 使用历史时不伪造“已完成”；
- 首页不额外请求完整 Provider Snapshot，加载失败不把未知状态猜成“未配置”；
- 所有 CTA 都是真实 `button`，支持键盘、可见焦点与明确中文名称；
- Provider 保存、Agent 激活、导航返回和设置指南均能刷新到正确进度；
- 1180×760、1280×800 和窄窗口无水平溢出，不出现全屏 loading；
- 控制器、Node、Electron、产品旅程、包内真实 Host 与内部包回执通过；
- 新包全绿后再删除上一包，Downloads 与 `desktop/dist/internal` 始终各只保留一个版本。

## 7. 当前执行记录与计划复盘

- 2026-08-05：已完成产品计划、信息架构、旧三步提示计划、当前 UI 和测试基线复核；
- 计划范围保持为已有三步主路径的状态与动作增强，不增加新的产品模块。
- 2026-08-05：完成安全 Overview 投影、首页/设置共用状态机、真实 Catalog 刷新、启动中过渡态、
  激活 fail-closed、登出与迟到请求竞态保护；代码终审 `APPROVE`，无剩余 P0/P1；
- 源码验证已通过：Desktop Node `239 total / 234 passed / 0 failed / 5 skipped`，5 条为待接
  新包 Host 的显式门禁；六组 Electron 页面回归、首次引导状态矩阵、四档紧凑布局、1180×760
  视觉检查、产品旅程 `3/3` 与 `93 cases / 14 domains` 均通过；
- 产品 commit `d0902bc5e052606c87f7a2f7671eb133111a0c01` 已 clean push；receipt
  `desktop_internal_p6_d0902bc5e052_arm64` 为 `passed`，包内 arm64 Host 报告
  `grok 1000.1.1785873093001 (d0902bc)`；
- 包内真实 Host 执行完整 Desktop 门禁为 `239 passed / 0 failed / 0 skipped`；DMG checksum、
  ZIP CRC、构建与 Downloads 两侧严格 receipt、`SHA256SUMS` 和四个交付文件逐字节比较通过；
- ZIP 包内 `app.asar` 的 `app.js`、`style.css`、`preload.js`、`main.js` 与提交源码逐字节一致，
  并包含真实 Agent Catalog 刷新；DMG 与 ZIP 的 Host、`app.asar`、主 `Info.plist`、听写 Helper、
  Helper `Info.plist` 与 capabilities 逐字节一致；
- DMG 为 `181624806` bytes，SHA-256
  `a699ef468ce2a6d072d605b4bea90f0309a672ba4723f1ebd2e91d571be82736`；ZIP 为
  `181428040` bytes，SHA-256
  `d33e69a19926ce3828fae7c6986c7980c4c635e26600d69b0570d85b326da16a`；
- 完整安装生命周期因真实 `/Applications/AgentMesh360.app` 已存在而按设计 fail-closed，
  没有移动、启动、覆盖或修改当前安装；owner 安装后的动态 UAT 仍由 owner 使用新包执行，
  不把这条安全拒绝冒充安装完成；
- Downloads 唯一目录为
  `/Users/ferdinandji/Downloads/AgentMesh360-Internal-Test-2026-08-05-d0902bc-arm64`，构建证据
  只保留 `desktop/dist/internal/0.1.1-d0902bc5e052-arm64/`。新包全部通过后才删除旧 `dba4275`
  两份与临时解压/挂载目录；根 `target/`、`desktop/.native-build` 均不存在。

计划复盘：本轮没有新增页面、Provider、会话后端、Agent 商店、P7/P8、签名、公证或线上
发布；实现、自动化、代码终审、冷构建、包内真实 Host、DMG/ZIP、交付副本和单包清理已经
闭环。下一步只由 owner 从上述唯一目录覆盖安装并按首页真实状态完成 UAT；本轮不自动修改
当前安装，也不继续横向扩展。
