# 持久 Agent 主对话恢复故障修复

更新时间：2026-07-31
状态：进行中
进度：90%

## 1. 本轮触发

Owner 在真实安装客户端中完成 Job Agent 的模型保存后，进入“对话”页仍出现：

- 状态“需要重新打开”；
- 错误“暂时无法打开此 Agent 的主对话”；
- 点击“重新打开”不能恢复。

这说明上一轮只验证了模型选择和保存，没有把“保存模型 → 建立 Main Session Binding
→ 激活/恢复持久 Session → 打开可用对话”作为不可拆分的交付旅程。

## 2. 根因

根因不是 GLM Key、模型、订阅或 credits：

1. P5 E1 本地 canary 只隔离了 `AGENTMESH360_HOME` 和 Electron `userData`，
   没有隔离 `HOME` / `GROK_HOME`；
2. P5 的 Job Agent Session 因此被写进真实 `~/.grok/sessions`，但其 cwd 指向已经删除的
   P5 临时 Workspace；
3. Rust Host 激活 Agent 时按 Session ID 跨 cwd 搜索，错误恢复了 P5 Session，并把
   当前 Agent 标记为常驻；
4. Desktop 随后按 Registry 中正确的当前 Workspace 执行 `session/load`，那里没有对应
   持久 Session，于是打开失败；
5. 同时，常驻 Agent 第一次保存模型时若 Session Binding 历史为空，Controller 会直接
   返回，导致界面显示已保存但首个 Binding 没有真正建立。

## 3. 本轮边界

本轮只修复既定主路径和造成它的测试隔离缺口：

- Host 只能从 Registry 记录的 canonical Workspace 恢复固定 Main Session；
- 首次模型保存必须初始化 Main Session Binding；
- 打开对话期间先显示真实加载态，不能短暂显示假“已连接”；
- P5 同时隔离 `HOME`、`GROK_HOME`、AgentMesh 状态、Electron `userData` 与 XDG 目录；
- 已安装 UI 验收必须按当前 Agent 管理入口检查“可发送且无错误”的真实对话状态。

不扩展 Provider 自动 fallback、价格/余额、在线商店、P7/P8、生产发布或付费 Provider
调用。下一产品切片仍是既定首次使用引导。

## 4. 测试合同

本轮必须同时满足：

1. 失败回归先在旧 Host 上稳定复现跨 Workspace 错误恢复；
2. 修复后同一真实 Host 用例通过；
3. 首次模型保存会调用 `resolveSessionBinding`；
4. Electron 真实点击保存后立刻进入“对话”，状态为“已连接”，输入框和发送按钮可用；
5. 管理 snapshot 延迟时只显示“正在加载”，输入框和发送按钮禁用；
6. P5 缺少或漂移 `HOME` / `GROK_HOME` 时 fail closed；
7. Rust AgentMesh 模块、Desktop Node、四组 Electron smoke、产品旅程和内部安装包验收
   全部通过；
8. KimiCLI 对完整 diff 和关键回归独立复核，P0/P1/P2 清零；
9. 新包完全验证后再删除旧包，最终只保留一个内部测试包。

## 5. 当前证据

- 旧 Host 运行新增跨 Workspace 回归：稳定失败并创建第二个同 ID Session；修复后的
  Host 明确 `workspace conflict`，`runtimeState=error` 且目录数保持 1；
- 真实 Host 跨层：4 passed / 0 failed，包含首次模型保存 → initial Binding →
  canonical Main Session → 对话 `ready`，并硬性禁止 `promptSession`；
- Rust AgentMesh 模块：202 passed / 1 ignored / 0 failed；Clippy `-D warnings` 通过；
- Desktop Node：136 passed / 5 个显式真实 Host/生命周期 gate skipped / 0 failed；
  另行启用当前 Host 后真实 Host 4/4 通过；
- Agent 管理、Conversation、Provider、Agent Package 四组 Electron smoke：通过；
- P5 准备、运行、清理与 runtime 边界测试：25 passed / 0 failed；
- Repository 工具链：306 passed / 0 failed；产品旅程：68 条、14 个领域通过；
- KimiCLI 独立检查完整 diff 并复跑 Node/Electron；发现 `TC-CONV-008` 文档仍写成
  “同 ID 双目录可 ready”，修正后再次静态复验，结论 P0/P1/P2 全部 `CLEAN`；
- KimiCLI 一次误用仓库默认 `target/` 生成约 12 GiB 编译缓存并触发 ENOSPC；该缓存已
  完整删除，后续 Rust 构建只允许使用 `/private/tmp` 的 `CARGO_TARGET_DIR`；
- Provider 请求 0、真实 Key/Keychain 读取 0、AgentMesh credits 0、费用 $0。

## 6. 待关闭

- 更新 `PROJECT_PROGRESS.md` 和本轮执行记录；
- clean commit、推送、构建并验证唯一内部包；
- 使用新包在真实 owner 本地状态中验证 Job Agent 可打开对话，但不发送真实消息；
- 清理旧包、旧构建证据、仓库 `target/` 与已确认的 P5 测试泄漏目录。
