# Agent 模型首次绑定保存修复

更新时间：2026-07-31
状态：实现、自主回归与 KimiCLI 交叉测试完成，等待内部包交付
进度：90%

## 1. 用户实际问题

常驻 Job Agent 尚无 Agent/main 模型绑定时，用户已经在“模型”页选择
“智谱 GLM Coding Plan / glm-5.2”，但“保存模型设置”仍为禁用，页面同时继续显示
“尚未选择模型”。用户无法通过真实鼠标点击保存。

## 2. 根因

Renderer 的模型 `change` 事件会更新 `agentManagementUi.modelDraft`，但只在表单存在
`confirmActivation` 时重新计算提交按钮。该复选框只属于未激活 Agent，因此已经常驻、
但没有模型绑定的 Agent 选择模型后，内部草稿存在，按钮状态却不更新。

原 Electron smoke 使用程序化 `form.requestSubmit()`，它没有先断言按钮可点击，
因此绕过了普通用户只能点击按钮的真实限制。

## 3. 方向复核

本修复仍属于“具体 Agent 管理自己的 Provider/模型”，没有把 Assignment 放回
模型供应商页；不修改 Host 路由优先级、BYOK、订阅硬门、自动 fallback、Provider
价格/余额、在线商店、P7/P8 或生产发布。

## 4. 实现与验收

1. 常驻 Agent 选择模型后立即按草稿重新渲染；
2. 保存按钮从禁用变为可点击；
3. 顶部明确显示“供应商 · 模型（尚未保存）”；
4. 原“尚未选择模型”错误改为“点击保存后生效”的非错误提示；
5. 测试必须通过真实按钮点击产生保存请求，禁止用 `requestSubmit()` 掩盖禁用状态；
6. Host 保存失败时保留选择、显示错误并恢复可点击按钮，可直接重试；
7. 新增 `TC-MODEL-005`，并盘点当前全部可交互页面的控件、成功/失败/恢复覆盖。

## 5. 当前自主验证

- 新用例在修复前稳定失败：`true !== false`，证明复现了截图中的禁用按钮；
- 修复后 Agent 管理 Electron smoke 通过，包括真实点击、失败保留和直接重试；
- Desktop Node：129 passed / 3 个显式 real-Host gate skipped / 0 failed；
- Conversation、Provider、添加 Agent 三组 Electron smoke 通过；
- Desktop syntax 通过；
- 产品旅程：63 条、14 个领域通过结构与执行校验；校验器单元测试 3/3；
- KimiCLI 独立审查代码、测试和覆盖矩阵，并连续两次复跑 Agent 管理 smoke；
  Desktop Node、其余三组 Electron 和旅程校验也由其复跑通过，最终结论为
  “无阻断问题，P1/P2 均无”；
- 没有读取真实 Provider Key、发起 Provider 请求、消耗 credits 或产生费用。

## 6. 剩余完成门

1. 提交并推送 clean commit；
2. 构建、复验并交付唯一新内部包，新包通过前保留上一包；
3. 回填 commit、receipt、摘要、清理结果并关闭循环 141。
