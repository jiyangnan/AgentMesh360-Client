# “停止当前任务”取消链路修复开发计划

状态：完成；源码、自动化、clean push、唯一内部包复验与旧包清理均已闭环
日期：2026-08-04

## 目标

修复用户点击“停止当前任务”后，Harness 实际已经取消当前 Turn，但客户端仍持续显示
“Agent 正在处理”、停止按钮仍可重复点击的问题。停止必须是独立的高优先级控制：不依赖
Queue 是否已同步，也不被普通 Queue 编辑操作阻塞；Host 完成取消后必须广播新的权威运行态，
客户端据此恢复输入和空闲状态。

## 与既定产品计划的关系

本轮只收口 Grok-first 输入系统 V2.3 已开放的标准 ACP `session/cancel`，不增加新的输入
能力、不改变 Provider、订阅、credits、Package 或 Agent 业务流程。继续坚持 Host Queue 是
运行态唯一 authority，Renderer 不能自行假定任务已经停止。

## 已确认的现场证据

- 2026-08-04 18:21:08 的本机 Host 日志记录了 `shell.cancel.received` 和
  `shell.cancel.processing`；Session 事件同时记录 `turn_ended: cancelled`，说明按钮、IPC、
  ACP 与 Harness 终止本身均已生效；
- 同一会话随后又收到两次取消，`prompt_id` 已为 `null`，说明界面仍把已停止的任务显示为
  运行中，允许用户重复点击；
- 根因是取消移除最后一个 running prompt 后，`maybe_start_running_task` 在无待处理项时直接
  返回，没有发布 `runningPromptId: null` 的更高 `queueRevision`；Desktop 因坚持权威 Queue
  快照而保留旧 running 状态。

## 实施顺序

- [x] 复核产品计划、现场 Host 日志与 Renderer → Main → ACP → Harness 全链路；
- [x] 先补失败回归：取消唯一 running prompt 后必须广播空闲 Queue 快照；
- [x] 修复 Harness 取消后的权威 Queue 广播，并覆盖“无队列”和“保留后续队列”两种场景；
- [x] 将 Desktop 停止操作与 Queue mutation 解耦，增加“正在停止…”反馈和防重复点击；
- [x] 补 Controller 与 Electron UI 的停止完成、失败、未同步 Queue、重复点击测试；
- [x] 执行 Rust、Desktop、Electron、产品旅程和格式回归；
- [x] 更新测试用例与项目进展，复核计划没有横向扩展；
- [x] clean commit/push，生成并严格复验唯一内部包；新包全绿后再删除旧包。

## 当前回归证据

- Desktop Node `232 total / 227 passed / 0 failed / 5 skipped`，停止 Controller 定向
  `53/53`；5 条 skipped 仍是显式打包 Host 门禁；
- Rust 取消相关 `20/20`、Prompt Queue `38/38`；唯一 running 与保留两条后续 Prompt 均验证
  权威广播；
- Conversation Electron 通过，包括 Queue mutation pending 时仍可停止、即时反馈、防重复与
  idle 恢复；四档紧凑视口全部通过；
- 产品旅程验证器 `3/3`，`89` 条、`14` 个领域完整且都有执行结果；syntax、fmt、diff check
  通过。

## 内部包交付证据

- 产品 commit `75b225b520dc854fb330d5fa5ff73b1b5e6d4755` 已 clean push，回执
  `desktop_internal_p6_75b225b520dc_arm64` 为 `passed`；包内 arm64 Host 报告
  `grok 1000.1.1785843306001 (75b225b)`；
- DMG 为 `181433730` bytes，SHA-256
  `9bdfe954a6ce9279d0004f5e5b7a21dad9a46e0639a76512343f5524b4edb21a`；ZIP 为
  `181229582` bytes，SHA-256
  `471190f144b7fe80def527982d4375cbfaeffa07008453f4323b23a8e3dbd934`；严格 receipt、
  `SHA256SUMS`、`hdiutil verify`、ZIP CRC 和构建/Downloads 四文件逐字节比较均通过；
- 只读挂载的 DMG 与解压 ZIP 中，Host 和听写 Helper 分别逐字节一致；两个 Host 均为 arm64
  且绑定本次产品 commit。以新包 Host 执行的五条真实 Host 门禁 `5/5` 通过；
- 完整安装生命周期工具因 `/Applications/AgentMesh360.app` 已存在而按安全设计拒绝覆盖；没有
  移动、覆盖或修改当前安装及 Login Item。此项记录为 fail-closed 安全边界，不冒充生命周期
  全通过；
- 首次冷构建被磁盘峰值中止，随后按一次性交付属性关闭 Cargo 增量、限制并发，并使用上游
  明确支持的 `GROK_SHELL_BUNDLE_RG_PATH=/opt/homebrew/bin/rg` 离线构建；最终临时目录已销毁，
  未调用 Provider、Core、Job、credits 或外部上传；
- Downloads 与构建证据现在各只保留一份 `75b225b` 新包；旧 `62eaca0`、验证临时目录、
  根 `target/` 与 `.native-build` 均已清理。

## 测试合同

1. running prompt 是唯一任务：点击停止后 Host 广播更高 revision、`runningPromptId = null`、
   Queue 为空，PromptResponse 为 `cancelled`，客户端恢复 ready；
2. running prompt 后有排队任务：先广播当前任务已移除，再由下一任务晋升广播新的 running；
   排队任务不能丢失；
3. Queue 尚未同步或正在执行普通编辑时，只要当前 Session 确实运行，停止仍可送达；
4. 首次点击立即显示“正在停止…”，按钮禁用；重复点击不重复发送；
5. Host 发送失败时恢复可点击状态并展示安全错误；
6. 自动化只使用 fake Host/本地临时状态，不调用真实 Provider、Core、credits 或外部服务。

## 非目标与边界

- 不把停止改成清空待处理队列；排队任务仍按既定 Queue 语义保留；
- 不默认终止已经明确后台化的长期任务；本按钮只停止当前前台 Turn；
- 不通过 Renderer 乐观清除 Host 状态，最终完成仍以权威 Queue/Prompt 终态为准；
- 不借本轮调整 Agent Prompt、Provider 目录、听写、附件或多会话产品结构。
