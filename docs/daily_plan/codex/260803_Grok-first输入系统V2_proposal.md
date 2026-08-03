# Grok-first 输入系统 V2 开发计划

状态：V2.2–V2.6 与全量门禁完成；运行态附件意图恢复修复待 clean push 后刷新唯一内部包；
真实安装麦克风 UAT 待 owner 执行
日期：2026-08-03

## 目标

把 Composer 从“一次输入、等待整轮结束”的表单，升级为持久 Agent 的连续协作入口。所有
运行、队列、附件和权限状态由 Main 按 `account + agent + session` 管理；Renderer 只接收
安全公开投影，不自行伪造 Host 状态。

## 当前审计结论

1. 当前 Controller 是单一当前会话状态，切换 Agent 会丢弃后台 Session 通知；
2. `session/prompt` RPC 在 Turn 完成后才返回，不能把该 Promise 当作“已入队”回执；
3. Grok 的 `x.ai/queue/changed` 只有单条 Entry version，没有队列级单调 Revision，无法
   安全处理删除、清空、重排和重连后的乱序全量快照；
4. Queue mutation 是 Ext Notification，Desktop 需要无 request id 的受控发送接口；
5. 附件原来只属于 account + Agent 草稿，没有 Session/Prompt reservation，存在重复使用
   与切换后遗留风险。

## 实施顺序

- [x] 完成 V2.2 协议、Controller、附件与 UX 差距审计；
- [x] 建立 Prompt 级附件 reservation、私有清单、重启恢复和孤儿清理；
- [x] 给 Grok Queue 增加单调 `queueRevision` 及广播回归；
- [x] 给 Desktop ACP 增加 Prompt ID、Queue mutation notification 与标准 Cancel；
- [x] 把 Main Controller 重构为多 Session 权威状态，异步提交并消费 Queue 快照；
- [x] 增加紧凑 Queue Strip 与编辑、删除、重排、立即执行；
- [x] 实现调整当前任务、排队、立即执行、停止四种不同语义；
- [x] 实现安全 `/` 命令与已签名 Package `$` Skill；
- [x] 实现受控 `@` 文件、Prompt 历史和大段粘贴卡；
- [x] 在明确 macOS 权限与 STT Provider 合同后实现只转文字的听写；
- [x] 完成 Node、Rust、Electron、产品旅程、13 寸与重启/重连回归；
- [x] 更新架构、设计、测试用例和项目进展，生成唯一内部包并删除旧包。

## 关键验收

- Agent A 运行时切到 B，A 的队列、结果和附件仍继续对账，B 可独立发送；
- 连续提交三条 Prompt 不锁死 Composer，Queue 以更高 `queueRevision` 为准；
- 同一附件不能被两条 Prompt 使用；确定入队前失败恢复草稿，不确定结果不自动重发；
- Queue 删除、编辑、重排、清空、版本冲突和重连均以 Host 全量快照收口；
- 危险 Slash 命令、未签名 Skill、越界路径和符号链接不会进入 Renderer；
- 1180×760、1280×768、1280×800、1440×900 下只有 Transcript/浮层内部滚动，
  Composer 永远完整可见。

## 非目标和边界

- 不开放自由 Shell、yolo、永久批准、插件/Hook 信任或开发者命令；
- 不把真实 Session ID、cwd、附件路径、Key 或音频字节投影给 Renderer；
- 不增加模型/模式/推理强度的常驻 Composer 控件；
- 不进入 Provider fallback、价格余额、在线商店、P7/P8、签名、公证或公开发布。
