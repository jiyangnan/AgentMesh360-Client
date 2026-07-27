# Harness 后台活动 authority 与安全投影 v1

状态：Cycle 51 authority 审计与 Cycle 52 最小实现、验证、Kimi 独立复核均已完成

## 1. 目的

AgentMesh360 客户端需要让用户知道持久产品 Agent 是否仍有后台工作，但不能把历史
回放误报为仍在运行，也不能把 Grok Build 的命令、工作目录、输出、日志路径或内部
任务标识泄露给 Renderer。

本契约只定义 Grok Build Harness 中普通后台命令与 Monitor 的只读状态投影。它不把
定时任务、Todo/Plan、Goal、subagent 或 Agent 自有业务任务合并成一个含义不清的
“任务”对象。

## 2. authority 审计

### 2.1 普通后台命令与 Monitor

实时执行 authority 是当前 Session 的 `TerminalBackend` /
`BackgroundTaskRegistry`。原始 `TaskSnapshot` 包含 `command`、`cwd`、`output`、
`output_file`、`tool_call_id` 等敏感字段；现有 `x.ai/task/list` 还要求客户端提交
`sessionId`，因此不能直接暴露给 Renderer。

Harness 已经把生命周期写成两类 xAI Session 通知：

- `task_backgrounded`：任务进入后台执行；
- `task_completed`：任务成功、失败、被停止，或冷启动时失去上一进程控制权。

这些通知写入 Session `updates.jsonl` 并由 `session/load` 回放。冷启动加载时，
Shell 会扫描只有 `task_backgrounded`、没有 `task_completed` 的记录；如果对应
Session 已不在当前进程内存中，就补发 `signal=session_restart` 的终态通知。温重连
到同一 Leader 时，Session 仍在内存中，不执行这项冷启动收口。

通知流提供了主要恢复语义：

- 同一 Leader 内的回放 `running` 仍对应可管理的实时进程；
- Leader/Host 冷启动后的遗留记录会在同一次 `loadSession` 中被收口为 `stopped`；
- 客户端不需要新建任务数据库，也不需要用命令、PID 或日志文件自行猜测存活状态。

真实 Host 验证还发现一个 AgentMesh360 特有的时序：订阅 bootstrap 会先恢复已激活的
常驻 Main Session。冷启动收口通知可能发生在用户打开对话、Controller 开始订阅之前；
随后再次 `loadSession` 已属于温加载，只回放旧 `running`。因此通知流不能单独承担
产品客户端的最终对账。

v1 增加 Host-owned
`x.agentmesh360/agents/background-activities/list`。Renderer 仍只提交 `agentId`；
Host 从当前订阅账户 Registry 解析固定 Main Session，并从该 Session 的实时
`TerminalBackend` 取得快照。接口只向 Main 返回私有 task ID、类型和四态，不返回
命令、路径、输出或日志。Controller 在 replay 后立即对账：

- 实时快照中存在的任务以 Host 状态为准；
- replay 恢复为 `running`、但实时快照中不存在的任务收口为 `stopped`；
- 非 replay 的新通知不因一次并发快照缺失而被错误停止；
- 快照中存在、但 Controller 错过启动通知的任务会补建本地安全记录。

### 2.2 Scheduled Task

Scheduled Task 是 Scheduler 的独立对象。其状态可以通过 Resources Persistence 保存，
启动时会重新 announce；但通知同时携带完整 prompt、自然语言 schedule、下一次
触发时间和 subagent 关联。它描述“未来何时再次执行”，不是“当前后台进程是否仍在
运行”。

v1 不读取、不展示、不控制 Scheduled Task。后续必须单独定义时区、过期、durable /
non-durable、一次性/循环、暂停/删除权限以及 prompt 脱敏契约。

### 2.3 Todo / ACP Plan

`todo_write` 的 `TodoState` 是模型维护的 Session 协作草稿，并通过标准 ACP
`SessionUpdate::Plan` 投影。Grok Build 自己明确把它视作记忆和进度辅助，不是产品
业务交付物，也不证明某一步有真实进程在执行。

v1 不把 Todo/Plan 当作后台活动。公共项目步骤继续来自
`.agentmesh360/project-state-v1.json` 的派生 read model；如后续展示 Harness Plan，
必须作为独立的 Session 计划视图，并明确其模型生成属性。

### 2.4 Subagent

Subagent 有自己的 spawn/progress/finish、父子 Session、模型、输出、worktree 和恢复
语义。它是临时 Worker，不等于常驻产品 Agent，也不等于普通后台进程。

v1 不把 Subagent 合并到后台活动列表。后续如展示，只能使用单独的安全 Worker
投影，且不得泄露 child Session、模型路由、输出或 worktree。

## 3. v1 安全投影

Main 进程只接受当前已打开 Agent 的固定 Main Session 通知，并在
`session/load` 后调用上述 AgentMesh360 安全快照完成对账。Main 持有私有
`taskId → localId` 映射。Renderer 最多收到 50 项：

```json
{
  "backgroundId": "background-1",
  "kind": "command",
  "status": "running"
}
```

字段白名单：

- `backgroundId`：Main 本地单调生成，格式 `background-N`；
- `kind`：`command | monitor`；
- `status`：`running | completed | failed | stopped`。

状态映射：

- `task_backgrounded` → `running`；
- `task_completed` 且 `signal=session_restart` → `stopped`；
- `task_completed` 且 `explicitly_killed=true` → `stopped`；
- `task_completed` 且 `exit_code=0`，或 exit code 与 signal 都为空 → `completed`；
- 其他终态 → `failed`。

终态冻结。未知任务的 completion、错误 Session、错误通知 method、非法/超长 task ID、
未知 kind/status、重复 ID 和畸形 payload 全部忽略或让整次快照失败关闭。达到
50 项时优先淘汰最早的终态记录，尽量保留仍在运行的项目。

安全快照失败时清空任务投影，并只显示固定“后台活动状态暂时不可用。”；文本对话
仍可继续。成功 Prompt 后再次对账，收口通知丢失或启动时序造成的偏差。

## 4. 隐私与生命周期

以下字段永远不进入 Renderer：

- Host task ID、Tool Call ID、Session ID、账户与 Workspace；
- command、display command、description、monitor description；
- cwd、output、output file、PID、signal、exit code；
- start/end time、Provider、token、subagent 或 scheduler 数据；
- 原始错误和任意未知字段。

订阅失效、账户切换、切换 Agent、关闭对话、Leader 重连、Host 退出和 Prompt
超时都清空映射与公开列表。重新打开后只从 Host 的 Session replay 恢复；旧 authority
的迟到通知不能污染新对话。

Renderer 对 `backgroundId/kind/status` 再执行独立白名单，只渲染本地固定中文标签，
不渲染 Host 文本。

## 5. v1 非目标

- 不提供 kill、cancel、restart、pause、resume 或查看日志；
- 不调用或扩张会返回原始 `TaskSnapshot` 的 `x.ai/task/list`；
- AgentMesh360 安全快照不接收 Renderer 提供的 Session ID，也不返回原始任务字段；
- 不建立任务数据库、文件 watcher 或轮询；
- 不展示命令、说明、时间、输出、路径或可点击操作；
- 不接入 Scheduled Task、Todo/Plan、Goal 或 Subagent；
- 不加入 Job/LectureCast/Deploy 专属分支；
- 不修改 Provider、Agent Package、生产 Registry 或发布门。

## 6. 验收

1. 失败优先测试覆盖 live、replay、冷启动收口、终态冻结、边界上限与生命周期清理；
2. Controller 快照和 Renderer DOM 均不含任何原始任务字段；
3. 真实 Grok Host 测试覆盖 bootstrap 提前恢复常驻 Session 的实际时序：持久
   Session 遗留 `task_backgrounded` 被回放后，由安全快照对账收口为 `stopped`；
4. 全量 Node、语法检查、真实 Host、Electron smoke 与 Kimi 独立交叉测试通过；
5. Kimi 的 Blocker/High/Medium/Low 全部为零；
6. 仓库根目录不生成 `target/`，Rust 构建继续使用临时 `CARGO_TARGET_DIR`。
