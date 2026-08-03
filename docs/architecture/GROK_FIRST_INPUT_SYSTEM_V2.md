# Grok-first 输入系统 V2

状态：V2.1 已完成源码、回归与内部打包；V2.2 以后按本文顺序推进
更新：2026-08-03

## 1. 这次要解决的不是“多放几个按钮”

当前 Composer 已经能发送文字、图片、文件和网页链接，但产品交互仍把一次输入等同于
一次完整 Turn：Agent 开始工作后，输入框就失去作用。对于会持续几十秒甚至几分钟的
持久 Agent，这会直接阻断用户补充条件、纠正方向和安排下一步。

输入系统 V2 的目标是把 Composer 变成持续协作入口：

1. 空闲时提交新任务；
2. 工作时继续补充要求；
3. 后续可查看和管理待处理任务；
4. 需要上下文时再出现文件、命令、Skill、历史和语音入口；
5. 不把模型、协议、Harness 方法或内部服务节点堆到主对话视觉层。

## 2. 调研边界

Codex 部分只采用 OpenAI 当前公开文档和公开产品说明。本轮没有绕过 Codex.app 的桌面
安全边界读取私有 UI 树，因此下面只记录官方可以复核的能力，不把推测写成现状。

Grok Build 部分直接核对本仓库 fork 的源码。源码能力不等于 AgentMesh360 已经向用户
开放；必须经过账户、Session、权限、附件生命周期和 Renderer 安全投影后才可进入产品。

## 3. Codex 当前公开输入能力与交互启发

| 能力 | 官方公开交互 | 对 AgentMesh360 的启发 |
| --- | --- | --- |
| 图片上下文 | 桌面端可拖入或粘贴截图、图表和图片 | 保留当前拖放/粘贴，不另设“视觉模式” |
| 文件上下文 | 对话可附加文件；桌面产品把文件、预览和协作放在同一任务上下文 | 附件显示为可删除 Chip，来源与处理状态可见 |
| `/` 命令 | 在 Composer 输入 `/` 后出现可筛选列表 | 命令是按需浮层，不应长期占据输入框上方 |
| `$` Skill | 输入 `$` 调用 Skill，也可从 `/` 列表发现 | Agent Package 声明的用户 Skill 可进入同一命令面板 |
| 命令面板 | `Cmd/Ctrl+Shift+P` 或 `Cmd/Ctrl+K` 打开命令入口 | 高级能力应有键盘入口，不把所有功能变成固定图标 |
| 听写 | 官方命令参考提供 `Ctrl+Shift+D` 听写 | 语音第一阶段应转成可编辑文字，而不是假装模型理解音频 |
| 工作中调整 | Goal 运行时可继续发送消息调整执行方向 | 持久 Agent 工作时 Composer 必须继续可用 |

公开依据：

- [OpenAI 图片输入文档](https://learn.chatgpt.com/docs/image-inputs)
- [OpenAI 文件工作流文档](https://learn.chatgpt.com/docs/artifacts-viewer)
- [OpenAI 命令参考](https://learn.chatgpt.com/docs/reference/commands)
- [OpenAI Slash Commands 参考](https://learn.chatgpt.com/docs/reference/slash-commands)
- [OpenAI ChatGPT Work 与 Codex 说明](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)

最值得学习的不是控件外观，而是渐进披露：普通用户默认只看到输入、附件和发送；输入
特定触发字符或快捷键后，命令、Skill、历史等能力才在当前意图附近出现。

## 4. Grok Build 已有、客户端尚未完整封装的输入能力

| 能力 | Grok Build 源码状态 | V2 产品决定 |
| --- | --- | --- |
| 文本、图片、嵌入文件、链接 | ACP 已支持；V1 已接入 | 保留当前 Composer 与私有暂存合同 |
| 工作中补充要求 | `x.ai/interject` 已支持文字与图片 | V2.1 先开放文字“追加指令” |
| Prompt Queue | 有权威版本、顺序、编辑、删除、重排、立即执行和通知 | V2.2 在 Session 状态重构和附件预留后开放 |
| 停止当前任务 | 标准 ACP `session/cancel` | V2.3 作为运行态次要行动开放 |
| 打断并立即执行 | Queue `sendNow` | V2.3 与“追加要求”“排队发送”明确分开 |
| `/` 命令和动态 Skill | 有命令列表与模糊补全 | V2.4 只开放产品 allowlist 与已签名 Package 声明项 |
| `@` 文件上下文 | 有工作区 Suggest 与文件读取 | V2.5 先做目录 containment 和受控附件转换 |
| Prompt 历史 | 有工作区/会话历史与搜索 | V2.5 以历史按钮/上方向键按需出现 |
| 大段粘贴 | Pager 会折叠为粘贴卡片 | V2.5 避免长文本撑满 Composer |
| 语音 | `xai-grok-voice` 提供 STT | V2.6 只做听写；不宣称 Audio 内容块已可用 |
| Audio 内容块 | ACP Schema 有类型，但当前 Grok Prompt Parser 不接受 | 不开放音频理解入口 |

主要源码依据：

- 工作中补充：[`interject.rs`](../../crates/codegen/xai-grok-shell/src/extensions/interject.rs)
- 权威队列：[`prompt_queue.rs`](../../crates/codegen/xai-grok-shell/src/session/acp_session_impl/prompt_queue.rs)
  与 [`types.rs`](../../crates/codegen/xai-prompt-queue/src/types.rs)
- Queue UI 行为：[`queue_pane.rs`](../../crates/codegen/xai-grok-pager/src/views/queue_pane.rs)
- `/` 命令：[`slash_commands.rs`](../../crates/codegen/xai-grok-shell/src/session/slash_commands.rs)
- `@` 建议：[`suggest`](../../crates/codegen/xai-grok-shell/src/extensions/suggest)
- Prompt 历史：[`prompt_history.rs`](../../crates/codegen/xai-grok-shell/src/extensions/prompt_history.rs)
- 语音：[`xai-grok-voice`](../../crates/codegen/xai-grok-voice/src/lib.rs)

## 5. AgentMesh360 Composer 的状态设计

### 5.1 空闲状态

主视觉只保留：

- “＋”附件入口；
- 两行起始的文字输入；
- “发送”；
- 隐私说明：`附件仅在本机暂存，发送时交给当前模型；不会上传到 AgentMesh360`。

Enter 发送，Shift+Enter 换行。只有文字或附件至少存在一个时才允许发送。

### 5.2 Agent 工作状态

- 输入框保持可编辑；
- Placeholder 改为“继续补充要求，Agent 会在当前任务中调整方向…”；
- 主按钮改为“追加指令”；
- Footer 明确这是调整当前任务，不是开启另一个任务；
- V2.1 暂时禁用“＋”、拖放和图片粘贴，避免文档/链接被误当作可中途注入；
- 追加失败时恢复原文字草稿，不能静默丢失。

“追加指令”使用 Grok 原生 `x.ai/interject`，不取消当前 Turn。Controller 只在当前
Session 确实处于 streaming 时接受，避免空闲时被 Grok 自动转成另一条优先 Prompt。

### 5.3 有排队任务时（V2.2）

只有队列非空时，Composer 上方才出现紧凑队列条；默认最多露出三条和总数，不常驻一个
大型任务面板。展开后允许编辑、删除、重排和立即执行。

队列不能只做 Renderer 本地数组。实现前必须同时完成：

1. Main Controller 按 `account + agent + session` 保存状态；
2. 消费 `x.ai/queue/changed` 权威版本；
3. Prompt 级附件 reservation，排队后不能被另一个草稿删除或复用；
4. 发送 IPC 不再把“等待整个 Turn 完成”误当作“服务器接受排队”的确认；
5. Agent A 在后台执行时，切到 B 后 A 的队列和结果仍能正确对账。

### 5.4 命令、Skill、文件与语音

- 输入 `/`：显示经过产品 allowlist 的命令；危险的 yolo、永久批准、插件安装、Hook
  信任和开发者命令默认不进入 Renderer。
- 输入 `$`：显示当前已签名 Agent Package 声明的用户 Skill。
- 输入 `@`：只搜索当前 Agent 明确授权的工作区；结果必须经过 canonical containment，
  不能允许绝对路径、`../../` 或符号链接越界。
- 点击麦克风或快捷键：先转成可编辑文字，用户仍需确认发送。
- 模型、工作模式和推理强度继续位于 Agent 齿轮设置，不回到主对话固定视觉层。

## 6. V2.1 本轮实现合同

本轮只关闭最短、最重要的持续协作链路：

1. 用户指定的准确隐私文案；
2. Enter 发送、Shift+Enter 换行，输入法组合态不误发；
3. Agent 工作时 Composer 继续可用；
4. 文字“追加指令”接入 `x.ai/interject`；
5. Host 广播作为唯一用户消息回显，不做乐观重复消息；
6. 插话只属于当前私有 Main Session，Renderer 不取得 Session ID；
7. 插话失败恢复草稿；运行态附件入口明确禁用；
8. 1280×800 与 1440×900 下仍由 Transcript 独立滚动，Composer 完整可见。

本轮不实现完整队列、停止、send-now、`/`、`$`、`@`、历史、大段粘贴卡片、语音、
图片插话或音频理解，也不改变 Provider、credits、订阅和 Package 发布边界。

## 7. 验收场景

V2.1 至少覆盖：

- 空闲时 Enter 发送，Shift+Enter 不发送，中文输入法组合态不误发；
- Turn 运行时输入框可编辑、“＋”禁用、按钮为“追加指令”；
- 插话进入当前私有 Session，Host 广播后只显示一次独立用户消息；
- 插话不把 `streaming` 改成 false，不取消原 Turn；
- 空闲、无 authority、超长输入、Host 拒绝均失败关闭；
- 插话失败恢复当前 Agent 草稿，切到其他 Agent 不串线；
- 用户可见文案不出现 Core、Host、Bridge 等内部节点；
- 13 寸窗口中运行态提示不把 Composer 推出视口。

V2.2 起必须另补：两条以上队列、乱序通知、版本冲突、重连、跨 Agent 后台状态、排队
附件删除/失败/取消/重启，以及 `@` 路径越界和危险 Slash 命令不可见等负向测试。
