# Provider 动态模型发现与连接诊断

更新时间：2026-07-30  
状态：完成
进度：100%

## 本轮目标

把 Provider 新建流程调整为：

```text
选择供应商 → 填写 API Key → 验证 Key 并读取可用模型
→ 选择模型 → 真实连接测试 → 安全保存
```

同时放大配置表单与文字，修复当前把所有 Host 错误误判为“接口地址无效”的问题。

## 影响范围

- Host：新增一次性凭据驱动的模型发现 ACP 方法；只请求官方模型元数据，不写 Vault，
  不执行模型推理，不产生 AgentMesh credits；
- Desktop Main/Preload/Controller：增加模型发现 IPC 与输入校验，Renderer 只接收
  脱敏模型列表；
- Renderer：官方供应商不再预填固定模型，Key 校验通过后显示动态模型选择框；
- 测试：覆盖 Key 不落库、官方端点/认证 Header、模型解析、失败码、模型选择失效规则、
  真实 Electron 表单流程和现有连接测试回归。

## 边界与风险

- 一等预设覆盖 OpenAI、xAI、Anthropic、Google Gemini、DeepSeek、GLM API、
  GLM Coding Plan、Kimi 国际/中国 API 与 Kimi Coding Plan；
- GLM/Kimi Coding Plan 使用专属端点和专属 Key 提示；套餐权益适用范围以供应商
  当前官方条款为准，技术连通不冒充商业授权；
- 自定义/本地兼容端点继续允许手工填写模型，不把未知接口冒充官方模型发现；
- 模型发现使用一次性 Key、禁止重定向、限制响应大小和模型数量，错误响应不回传正文；
- 模型列表成功只证明 Key 可以读取元数据；仍必须对用户选择的模型执行一次真实连接
  测试后才能保存；
- 不读取已保存 Key；编辑 Profile 若要重新获取模型，用户需要重新输入 Key。

## 验收口径

- 官方供应商选择后模型框为空且不可选，不再展示 Catalog 固定示例；
- 输入 Key 后可明确点击“验证 Key 并获取模型”，成功后出现该 Key 实际可见的模型；
- 用户选择模型后才能测试连接，测试成功后才能保存；
- 401/403、429、超时、无模型、模型不可调用和地址错误显示不同中文说明；
- 表单输入高度、字号和状态说明在 1180px 窗口下清晰可读；
- 定向测试、完整桌面测试、Host 测试、UI smoke、格式与静态检查全部通过。

## 执行清单

- [x] 复核产品计划、Provider ADR、当前实现和官方模型 API
- [x] 实现 Host 动态模型发现与结构化错误
- [x] 串通 Desktop IPC/Controller/Preload
- [x] 重做模型选择与表单尺寸
- [x] 补齐测试用例与自动化
- [x] 完整复核并更新项目进展
- [x] 提交推送并生成单版本内部测试包

## 完成证据

- 功能 commit `9e6ea87439d606f87a651fc364c0c443313d73cf` 已推送
  `origin/main`；
- receipt：`desktop_internal_p6_9e6ea87439d6_arm64`；
- DMG、ZIP 摘要、receipt verifier、`hdiutil verify` 与 Downloads 交付副本复验
  全部通过；
- 最终只保留 `9e6ea87` 对应的一份 Downloads 包和一份内部构建证据；
- 下一轮回到既定首次使用引导，不扩展价格、余额、自动路由或在线发布。
