# 产品用户旅程测试基线与 GLM Coding Plan 连接修复

更新时间：2026-07-31
状态：完成
进度：100%

## 1. 为什么做

owner 使用真实 GLM Coding Plan Key 已成功读取 8 个模型，但选择 `glm-5.2` 后，
连接测试把 Provider 的成功响应判为“没有有效内容”。同时，当前测试用例只覆盖近期
Provider 变更，没有把登录、订阅、持久 Agent、会话恢复、Provider、Package、后台
Host、设置和内部安装串成完整的用户旅程。

这导致功能虽然有大量底层回归，真实用户仍可能成为首次发现产品级断点的人。本轮把
“用户故事 → 可执行用例 → 自动化/人工证据 → 缺陷修复 → 回归”固化为后续每轮都要
执行的研发门禁。

## 2. 本轮目标

1. 依据产品蓝图梳理当前产品的角色、入口、状态和端到端用户旅程；
2. 在唯一测试用例文档 `docs/test-cases/test-cases.md` 中，为每条核心旅程记录：
   用户故事、优先级、前置条件、输入、交互步骤、预期输出、失败语义、验证层和状态；
3. 增加机器可校验的用例索引，防止测试文档再次退化为零散功能说明；
4. 按用例执行当前版本可自动化和可安全人工验证的场景，并如实标注通过、阻断、
   尚未实现或需要外部付费授权的场景；
5. 修复 GLM Coding Plan `glm-5.2` 最小推理被误判为空响应的问题，增加真实 wire
   契约回归；
6. 所有门通过后更新进展、生成唯一 unsigned internal arm64 测试包并替换旧包。

## 3. 产品范围

### 本轮覆盖

- 安装与首次启动；
- Google/GitHub/邮箱兼容登录、凭据恢复与注销；
- 订阅有效、失效、网络暂不可用和后台复验；
- 持久 Agent 浏览、激活、打开、切换、恢复；
- 固定 Main Session 对话、草稿、权限、活动、产物、项目状态和计划；
- Provider 动态模型发现、连接测试、保存、分配、编辑和错误恢复；
- Agent Package 目录、权限批准、安装、更新、回滚和关闭态；
- 后台 Host 常驻、升级接管、崩溃恢复和单实例；
- 客户端设置、Login Item 与本地安全边界；
- unsigned internal 包的构建、留存和本机交付。

### 本轮不做

- 不新增 Provider Catalog；
- 不实现首次使用引导视图，仍按既定顺序把它保留为下一产品切片；
- 不启用生产 Trust/Registry、在线发布、自动更新或生产 Apple 签名/公证；
- 不使用生产密钥，不读取已保存 Provider Key，不擅自发起可能计费的真实 Provider
  请求；
- 不改变订阅硬门、BYOK 默认、Session Binding 或 AgentMesh credits 边界。

## 4. GLM 故障初步判断与验收口径

智谱官方文档确认 GLM Coding Plan 的 OpenAI Chat Completion Base URL 为
`https://open.bigmodel.cn/api/coding/paas/v4`。`glm-5.2` 默认开启思考，
`reasoning_effort=none` 可以让它放弃思考；官方同时建议普通推理的
`max_tokens` 不小于 1024。

当前连接测试只允许 16 个输出 token，且未关闭 `glm-5.2` 的默认思考。模型可能在
极小 token 预算内只返回 `reasoning_content`，没有来得及返回可见 `content`，
Host 因而把 HTTP 成功误判为“空响应”。

本轮验收：

- GLM Coding Plan + `glm-5.2` 的一次性连接测试必须在 wire 上显式使用
  `reasoning_effort=none`，保持短提示、无工具和有界输出；
- 其他 Provider 的请求不得被注入 GLM 专属参数；
- 推理响应有可见文本时通过；只有 reasoning、空 delta 或真正空响应时仍失败关闭；
- Key、Header 和原始 Provider 正文不进入 DOM、日志、数据库或测试证据；
- 不把模型目录成功冒充为推理成功。

## 5. 执行顺序

- [x] 复核产品蓝图、当前进展、Provider ADR、专项计划和现有测试用例
- [x] 核对智谱官方 Coding Plan、Chat Completion 和 Thinking 契约
- [x] 修复 GLM Coding Plan 连接测试并补齐定向回归
- [x] 重写全产品用户旅程测试用例文档
- [x] 增加测试用例结构/覆盖校验器
- [x] 运行 Rust、Desktop、Electron UI、静态检查和秘密扫描
- [x] 执行当前可安全完成的桌面人工旅程并记录证据
- [x] 更新项目进展与产品蓝图中的当前测试门说明
- [x] 复核计划偏差，确认下一轮仍是首次使用引导
- [x] 生成唯一内部测试包、删除上一包、提交并推送

## 6. 完成定义

只有以下条件同时满足才结束本轮：

1. GLM 缺陷有代码根因、官方契约依据、自动化回归和桌面交互复验；
2. 产品所有已规划核心场景都出现在唯一测试用例文档中，且输入/输出/交互明确；
3. 用例覆盖校验和当前可执行测试实际运行，不把未执行写成通过；
4. 完整 diff、格式、静态检查、秘密边界和既定计划由主 Agent 加强自主复核；
5. 项目进展、专项计划和下一轮目标同步；
6. 新包通过后才删除旧包，并且最终只保留一份内部测试包和一份构建证据；
7. commit 已推送 `origin/main`。

## 7. 执行中复盘

1. GLM 失败根因与预判一致：`glm-5.2` 默认思考叠加 16-token 连接预算，可能只有
   `reasoning_content` 而没有可见 `content`。修复只对 Catalog 复验后的官方
   `glm` / `glm-coding-plan` + 精确 `glm-5.2` 注入 `reasoning_effort=none`；
   自定义端点和其他模型不受影响。
2. 45 条用例已覆盖 9 个产品领域，并由结构校验器强制字段和领域完整性。
3. 真实桌面交互额外发现侧栏切换会清空 Provider 和对话未发送草稿。已增加
   Renderer 内存草稿恢复：账户切换、注销和成功提交会清除；Provider Key 只恢复到
   password input 的 value property，不进入 HTML markup、日志或 Host。
4. 自动验证现为 AgentMesh360 Rust 197 passed / 1 ignored、Desktop Node
   122 passed / 3 real-Host gate skipped、工具链 306 passed、三组 Electron UI
   smoke 通过；Kimi 按 owner 指令暂停。
5. 当前唯一未关闭的功能证据是修复后对智谱真实 `glm-5.2` 的付费最小请求。没有本轮
   新费用授权，也无法读回 owner 未保存的 Key，因此保持外部真实服务阻断，不以
   loopback wire 回归冒充真实 Provider 通过。

## 8. 完成复盘

1. 45 条用户旅程已全部执行并回填：42 条通过、3 条外部真实服务阻断、0 条待执行、
   0 条失败；`--require-executed` 会阻止后续把待执行用例留在完成态。
2. 从 clean pushed commit
   `8df16f8c9c4510b1a6f9bd514001ce5a9929e61e` 生成
   `desktop_internal_p6_8df16f8c9c45_arm64`，receipt、DMG/ZIP SHA-256、
   `hdiutil verify` 和交付副本比较全部通过。
3. 覆盖安装后，Host runtime 为
   `1000.1.1785430165001 (8df16f8)`；旧 Leader 已按 version floor 让位，
   owner 账号、有效订阅、1 个常驻 Agent 和原有本地状态恢复。
4. 新增已安装客户端 loopback 验收脚本，实际证明十个官方 Provider、Provider
   假 Key 草稿和对话草稿跨侧栏保留；验收没有点击验证、保存或发送，Provider 请求和
   AgentMesh credits 都为 0，假值随后清空。
5. Downloads 与 `desktop/dist/internal` 各只保留当前一份，上一包、旧构建证据、
   临时 App、DMG 挂载和仓库 `target/` 已清理。
6. 计划没有偏移：本轮只修缺陷并建立 loop engineering 测试基线；下一产品切片仍是
   首次使用引导，不扩展价格、余额、自动 fallback、P7/P8 或在线发布。
