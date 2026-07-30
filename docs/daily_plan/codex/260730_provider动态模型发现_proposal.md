# Provider 动态模型发现与连接诊断

更新时间：2026-07-30  
状态：owner UAT 升级回归修复中
进度：85%

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

## Owner UAT 回归：安装新包后仍显示旧 Provider

### 事实与根因

- 新 DMG、`/Applications/AgentMesh360.app` 的 `app.asar` 和打包 Host 均包含
  DeepSeek、GLM 与 Kimi Catalog；
- owner 安装新包后，新 Electron/stdio Bridge 已启动，但 AgentMesh360 专属
  Grok Leader 仍是安装前启动的旧进程；
- 上游 Leader 只在新客户端语义版本严格更高时自动让位；当前每次内部包仍编译为
  `0.2.106`，因此代码已改变但运行时版本未改变，Bridge 合法复用了旧 Leader；
- 旧 Leader 被受控终止后，当前安装包立即拉起新 Leader，证明 Provider 实现与
  Artifact 正确，缺陷位于 Host 升级传播。

### 修复计划

- [x] 核对 DMG、已安装 App、Host 字节和真实进程启动时间
- [x] 受控轮换 owner Mac 的旧 AgentMesh360 Leader
- [x] 为每个内部构建派生单调递增的 AgentMesh360 Host runtime SemVer
- [x] 让打包 Host 与 Bridge 使用同一 runtime SemVer，自动替换旧 Leader并禁止降级
- [x] 升级 Desktop 版本并避免 ACP `clientVersion` 手工漂移
- [x] 隔离 Host `--version` 构建门禁，避免读取用户 Grok channel 缓存
- [x] 统一 Pager CLI、Leader、ACP 与 Version crate 的 runtime version 来源
- [ ] 补齐真实安装升级回归
- [ ] 更新进展、提交推送、生成并只保留一份修复包

### 验收口径

- 旧包 Leader 保持运行时安装并启动新包，新 Bridge 必须让旧 Leader 退出并由新包
  Host 接管；
- Leader 更换后不删除账户、Provider、Agent、Session 或工作区数据；
- Provider 页面读取到十个官方入口，明确包含 DeepSeek、GLM API、GLM Coding Plan、
  Kimi 国际/中国 API与 Kimi Coding Plan；
- 旧版本客户端不能驱逐更新版本的 Leader；
- 新包完成 receipt、摘要、DMG、交付副本和真实升级复验后才删除上一包。
