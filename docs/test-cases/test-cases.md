# AgentMesh360 Client 测试用例

## TC-PROVIDER-001：官方 Provider 动态模型发现

### 测试步骤

1. 进入 Provider 设置并选择 OpenAI、xAI、Anthropic、Google Gemini、DeepSeek、
   GLM、GLM Coding Plan、Kimi API 或 Kimi Coding Plan；
2. 确认模型选择框尚未预填固定值；
3. 输入 API Key，点击“验证 Key 并获取模型”；
4. 等待官方模型接口返回并选择一个模型。

### 预期结果

- 请求只从 Host 发往所选官方 Provider 的 Catalog 固定端点；
- Key 不写入 Vault、Profile、Assignment、Session、Probe history 或 Renderer DOM 文本；
- 成功后显示当前 Key 实际可见的模型，用户只能从返回列表中选择；
- 模型发现不执行推理、不要求费用确认、不消耗 AgentMesh credits。

## TC-PROVIDER-005：GLM/Kimi Coding Plan 专项入口

### 测试步骤

1. 分别选择 GLM API、GLM Coding Plan、Kimi API 与 Kimi Coding Plan；
2. 对比自动配置的名称、协议和官方地址；
3. 使用相应类型的 Key 获取模型；
4. Kimi Coding Plan 检查 Standard / HighSpeed 的实际账号权限。

### 预期结果

- 普通 API 与 Coding Plan 使用不同预设和官方端点；
- 页面明确提示 Coding Plan 专属 Key 和官方适用范围；
- 不要求用户手工填写协议或地址；
- 模型列表以当前 Key 的官方响应为准，HighSpeed 无权限时显示稳定权限错误；
- Catalog 中不会把 Coding Plan 套餐兼容性冒充为第三方商业授权。

## TC-PROVIDER-002：模型发现失败诊断

### 测试场景

- API Key 错误或无权限；
- Provider 限流；
- 网络超时或服务不可用；
- 模型接口响应非法或没有模型；
- 官方 Preset 的协议、认证方式或端点被篡改。

### 预期结果

- 页面分别显示身份验证失败、限流、网络、服务、响应或安全配置错误；
- 不显示 Electron IPC、HostRequestError、认证 Header、Key 或 Provider 原始错误正文；
- 模型选择和“安全保存”保持禁用。

## TC-PROVIDER-003：选择模型、连接测试与保存

### 测试步骤

1. 完成模型发现并选择一个模型；
2. 确认 Provider 费用提示后执行连接测试；
3. 测试成功后保存；
4. 修改 Key、模型或连接字段。

### 预期结果

- 连接测试只调用当前选择的模型；
- 测试成功前不能保存，成功后可以保存；
- 保存后 Key 立即从表单清空；
- 修改 Key、模型或连接字段会使旧测试和旧模型发现结果失效，必须重新验证。

## TC-PROVIDER-004：Provider 表单可读性

### 预期结果

- Provider、名称、Key 和模型控件高度不低于 48px，正文与输入文字清晰可读；
- 模型从多行手填框变成单选控件，流程提示与按钮动作一致；
- 1180px 窗口和窄窗口下不溢出，按钮仍可操作。
