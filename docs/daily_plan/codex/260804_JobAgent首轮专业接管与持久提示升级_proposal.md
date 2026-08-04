# Job Agent 首轮专业接管与持久提示升级开发计划

状态：源码与自动化完成；唯一内部包和项目进展证据待回填
日期：2026-08-04

## 目标

修复客户端 Job Agent 首轮表现为通用助手的问题，使它在每次开始或恢复工作时都先依据
Job Agent 的真实状态推进唯一正确的下一步：安全配置 Job Agent Key、上传并分析简历、
补齐画像、开始轮次，或从已有轮次的 `next_suggested` 继续。同时保证 Package 升级后
既有 Main Session 保留原历史，但下一条消息采用最新版产品定义。

## 与既定产品计划的关系

本轮属于“Provider 已配置 → Agent 已激活 → 固定 Main Session 真正开展垂直工作”的
P6 owner UAT 收口，不开启新的生产 Package、在线商店或发布阶段。它修复的是现有 Job
Agent Package 的运行时产品契约和持久会话升级语义，不新增一套聊天引擎、业务数据库、
Session 或 Supervisor。

继续遵守既定 authority：

- Grok Build Harness 负责推理循环、工具、权限、历史与定义重建；
- Package `runtime.promptBody` 是当前进入 Harness 的产品契约；
- Job Agent CLI/服务状态是 Key、画像、轮次与 `next_suggested` 的业务 authority，聊天
  文本不能自称已完成这些状态；
- `canonicalWorkflow` 继续用于受签 Package 校验、Authoring 和宿主 Skill 导出，当前
  不把它误写成运行时会自动全文加载；
- 账户、`agentId`、确定性 Main Session 和 Workspace 身份不因 Prompt 升级而变化。

## 实施顺序

- [x] 对照 Job Agent 源仓库与公开宿主 Skill，冻结首轮和续跑的状态决策表；
- [x] 将完整专业接管、安全边界和站内纵向流程写入 Job Agent `runtime.promptBody`，
  内置 Package 升级为 `0.4.8`；
- [x] 以完整 `AgentDefinition` SHA、Package 版本和 Overlay revisions 判定是否需要重建；
- [x] 恢复旧持久 Session 时强制重新核对当前定义，重建保留原历史与同一 Session；
- [x] 用 LectureCast 定义证明摘要与保历史重建是所有 Agent Package 的通用机制；
- [x] 完成 Manifest、Host fake Provider、旧会话升级和非 Job 隔离自动化；
- [x] 完成 AgentMesh360 Rust 回归与历史保护复验；
- [x] 完成 Desktop、产品旅程、格式与 diff 复验；
- [x] 修复 Finder 启动 Host 缺少官方 CLI 目录，并把 fake 工具链补为
  `--version → doctor env` 顺序执行；
- [ ] 更新项目进展，clean push，并生成、复验和单版本替换唯一内部包。

## 状态决策与预期交互

| 已验证状态 | Job Agent 必须直接执行的下一步 | 禁止行为 |
| --- | --- | --- |
| Key 缺失或无效 | 区分 Job Agent 服务 Key 与模型 Key；引导用户在本机安全入口执行初始化 | 要求把 Key 粘贴进普通聊天；伪造 Key |
| Key 有效但无画像 | 要求 PDF/DOCX/TXT/Markdown 简历；收到后执行简历分析 | 先搜索或投递；只罗列能力 |
| 已有画像、无轮次 | 补齐目标岗位与约束，开始 round | 重复注册或重复要求上传简历 |
| 已有 active round | 从 `next_suggested` 续跑当前站点和确认阶段 | 重置进度；跳过 review/preview |
| round 已完成 | 总结本轮并确认新目标 | 静默新建轮次 |
| 状态未知或冲突 | 说明边界和可恢复动作，失败关闭 | 猜测成“无 Key/无简历” |

任何状态都不得先输出通用能力菜单或宽泛询问“你想做什么”。招聘站点继续按 Boss 直聘
→ 猎聘 → 智联招聘 → 前程无忧纵向推进；每站遵守 login → discover → review →
preview → send → audit。只有真实 credits 不足且服务状态明确要求 paid pass 时才提示套餐。

## 测试合同

本轮新增 `TC-AGENT-007`，至少覆盖：

1. 无 Key；
2. Key 有效但无简历/画像；
3. 已有画像但无轮次；
4. 已有 active round 与 `next_suggested`；
5. 旧 Job Agent 定义创建的同一 Main Session 升级到 `0.4.8`；
6. LectureCast、Deploy 与动态 Agent 不被 Job 流程污染；
7. 定义或状态异常时失败关闭并保留历史。

自动化只使用固定 fixture、临时状态与 fake Provider，核对真正发给模型的 System Prompt
和会话历史。不得读取或保存真实 Job Agent Key，不调用真实 Provider、Job Agent 外部
服务、AgentMesh360 credits，也不产生费用。测试完成前用例结果保持“待执行”，不得以
源码存在替代运行证据。

通用性要求：定义摘要、Harness 重建和历史保留不能写成 Job 特判。后续任何动态 Agent
仍从宿主 Skill/Canonical Workflow 的同源版本形成 Package runtime，再由同一个 Grok
Harness 与本地稳定 Main Session 持久化；本轮用 LectureCast 定义变化验证这条边界，但不
扩展新的 Agent 产品流程。

## 非目标与边界

- 不新增 Job Agent 专属 Renderer 流程页或第二套业务状态；
- 不让客户端自动创建、展示或保存 Job Agent Key；
- 不自动投递、登录网站、消耗 credits 或绕过用户确认；
- 不改变 LectureCast、Deploy 或未来动态 Agent 的运行时 Prompt；
- 不启用生产 Trust/Registry、P7/P8、在线分发、自动更新、Developer ID 或公证；
- 不借本轮扩展 Provider、价格、余额、fallback、多会话或 Composer 功能；
- 不 source 用户 shell 配置；macOS Host 只在系统 PATH 尾部追加去重后的官方 CLI 常见目录；
- applied-definition map 暂时只在 Host 进程内，重启后允许一次保守的幂等重建，不在本轮
  增加新的持久状态 Schema。

## 本轮完成后的唯一下一步

完成全部 fixture/fake Provider 回归、文档、唯一内部包和 owner 本机复验后，只验证
Job Agent 的真实首轮与已有进度续跑是否符合上述状态表；若仍有偏差，继续收口本用例，
不横向扩展新功能。真实服务验证必须由 owner 另行明确授权，并使用可控次数、费用与
停止条件；未授权时保持零外部请求。
