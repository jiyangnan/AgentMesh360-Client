# Job Agent 0.5.6 持久包同步与猎聘复验计划

状态：源码与自动化完成；等待 clean commit 后构建唯一内部包
日期：2026-08-04

## 问题事实

- 官方仓库 `/Users/ferdinandji/AgentMesh-JobAgent` 当前 `main` 干净并与 `origin/main`
  一致；`v0.5.6` 对应提交 `4e13fa8cf9bd4785c4c2d14006cbd841146c4aea`，当前 HEAD
  `5af7b73` 只补充测试隔离；
- `0.5.6` 修复猎聘城市筛选：广州使用当前城市码、未内置城市从猎聘页面元数据安全解析，
  无法验证城市时返回 `liepin_city_code_not_found`，不再把错误筛选误报成
  `no_candidates`；
- 官方发行身份是 tag `v0.5.6`、commit
  `4e13fa8cf9bd4785c4c2d14006cbd841146c4aea`，按官方算法离线重算的规范 archive
  SHA-256 是 `d1062d683a616f87ffefc3e3590a8912c8a26e88f055ad0936070865bddd75b2`；
- 本机 `/opt/homebrew/bin/jobagent --version` 已返回 `jobagent 0.5.6`，但当前 executable
  实际连接到内部 `/Users/ferdinandji/Job Agent` 工作副本，而不是 Client 内嵌 CLI 或公开
  tag archive；该内部副本包含相同猎聘运行时修复。因而“版本输出正确”是必要证据，不是
  Client 传播已经完成的充分证据；
- 当前已安装 `/Applications/AgentMesh360.app` 的 Host 仍为
  `grok 1000.1.1785843306001 (75b225b)`，其中内置 Job Agent Package 是 `0.4.8`。
  当前本机持久 Registry 的 Job Agent 也仍记录 `0.4.8`，Active Package Registry 为空。
  因而“官方 CLI 已升级”不等于“当前持久 Agent 已采用 0.5.6 定义”。

## 本轮目标

1. 将 Client 内置 `com.agentmesh360.job-agent` 从 `0.4.8` 同步到官方能力版本 `0.5.6`；
2. 保证首次与恢复时先解析真实 CLI、核对 `jobagent --version`，低于 `0.5.6` 时停止平台
   命令并走官方升级/恢复，不用旧 CLI 继续猎聘；
3. 把猎聘 `liepin_city_code_not_found` 与真实 `no_candidates` 分开处理；客户端只执行并
   转述官方 CLI 结构化结果，不拼 URL、不解析猎聘 DOM、不另写抓取代码；
4. 用通用 definition digest 路径证明旧 `0.4.8` 持久 Main Session 升级到 `0.5.6` 后
   Session、历史与 Workspace 不变，下一条消息使用新定义；
5. 生成新的唯一内部包，包内真实 Host 全绿后才删除上一包；不自动覆盖当前安装。

## 实施范围

- 更新 Job Agent builtin Package manifest 与对应 catalog/upgrade 测试；
- 加固首轮/恢复 fake CLI 工具链，明确验证 `0.5.6` 版本输出进入真实 Sampling 上下文；
- 增加猎聘城市解析错误与 `no_candidates` 的运行时边界断言；
- 更新 `TC-AGENT-007` 并新增一条面向官方版本传播与猎聘诊断的结构化用例；
- 完成 Rust、Desktop、产品旅程、包内真实 Host、DMG/ZIP 和单包留存复验。

## 验收口径

- builtin catalog 报告 Job Agent `0.5.6`，非 Job Agent 定义不受影响；
- 真实进入 Harness 的 System Prompt 明确要求解析 CLI、先读版本、最低 `0.5.6`、复用同一
  绝对命令；Package/client 更新或命令恢复时先走官方 `upgrade-check` 与结构化恢复事件，
  并把猎聘城市解析交给官方 CLI；
- fake Provider 工具循环为 `--version → upgrade-check → doctor env → next_suggested`，且客户端可见回复
  不回退成通用菜单；
- `0.4.8 → 0.5.6` 在同一账号、Agent 与 Main Session 上保留历史并重建当前定义；
- 本机只读证据确认官方 CLI `0.5.6`；真实猎聘复验只在新 Client 被 owner 安装后沿原有
  持久 Job Agent/签名 review/preview/send/audit 流程执行，不把 CLI 直跑冒充 Client 验证；
- 若仍出现 `no_candidates`，证据必须能区分：包未传播、实际命令仍旧、持久会话未重建、
  官方 CLI 返回真实空结果；不得在 Client 新增猎聘抓取实现。

## 安全与非目标

- 自动化只用临时 CLI、fake Core/Provider 与隔离状态，不读取 Job Agent Key、招聘网站
  Cookie、简历、候选岗位或审计正文；
- 本轮不新增 Provider、会话、浏览器自动化、猎聘 selector、城市码或投递代码；
- 不删除 `~/.jobagent`、浏览器 profile、账号状态、round、decision、preview 或 audit；
- 不启用 P7/P8、签名、公证、在线发布或自动更新；
- 新包验证前保留上一份可用包，验证后仍严格只保留一份。

## 当前执行记录与计划复盘

- 官方 `v0.5.6` tag、canonical commit、规范 archive SHA-256 及猎聘错误分层均已离线核对；
  公开 parser/版本测试 `17/17`、内部猎聘边界测试 `7/7`，没有访问猎聘或用户状态；
- Client builtin Job Agent 已同步到 `0.5.6`，并完成当前版本、升级样本、回滚样本、远端下载
  fixture 与 Registry 断言的版本级联；冻结的 `0.4.8-e1.1` canary 和历史进展未被改写；
- 同一持久 Main Session 回归已覆盖：旧 CLI `0.5.5` 只执行 `--version` 后失败关闭；同一
  Session 恢复为 `0.5.6` 后按 `--version → upgrade-check → doctor env` 执行，保留此前可见
  历史、Session、Workspace，并在下一条 Sampling 使用新的 `0.5.6` definition；
- AgentMesh360 Rust 整组 `215 passed / 0 failed / 1 ignored`，Desktop Node
  `232 total / 227 passed / 0 failed / 5 skipped`，产品旅程 `3/3`、syntax、Rust fmt 和
  `git diff --check` 均通过。5 条 skipped 是要求包内真实 Host 的显式门禁，将在冷构建后执行；
- 最终只读审查指出，fake Provider 能证明 Harness 接线，却不能证明每个真实 BYOK 模型必然
  遵守版本门，也没有实际覆盖完整更新失败事件和两类猎聘结果。测试合同已拆成自动化传播
  `TC-AGENT-008` 与 owner 安装后真实复跑 `TC-AGENT-009`；后者明确保持阻断，不用全绿文档
  冒充真实 UAT；
- 实际用户持久 Job Agent 的猎聘复跑仍不能在旧安装包上冒充完成。源码 clean commit 后先生成
  新内部包，验证包内 Host 与 `0.5.6` definition，再由 owner 覆盖安装并从原 Main Session
  续跑；本轮没有向 Client 添加猎聘城市码、URL、selector、DOM 或抓取逻辑。
