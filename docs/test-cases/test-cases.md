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

## TC-PROVIDER-006：安装新客户端后自动替换旧持久 Host

### 测试场景

- 场景 1：旧版本 AgentMesh360 Leader 保持运行时安装新客户端；
- 场景 2：新旧包使用不同 Desktop 版本和单调 Host runtime SemVer；
- 场景 3：旧客户端不能反向驱逐新 Leader；
- 场景 4：Leader 轮换后保留账户、Agent、Provider 和 Session 数据。

### 测试步骤

1. 启动上一内部包并记录 AgentMesh360 专属 Leader PID、Host runtime 版本与 Catalog；
2. 保持 Leader 运行，退出 Electron UI，再安装当前新包；
3. 启动新客户端，等待 Bridge 连接专属 socket；
4. 检查旧 PID 退出、新 PID 接管，且新 Leader 版本严格高于旧版本；
5. 登录后进入 Provider 设置并读取 Catalog；
6. 确认十个官方入口包含 DeepSeek、GLM API、GLM Coding Plan、Kimi 国际/中国 API
   与 Kimi Coding Plan；
7. 检查原账户、已激活 Agent、Provider Profile、Session 与工作区仍可恢复；
8. 用较旧 runtime 版本客户端连接，确认它采用新 Leader 而不触发降级替换。

### 验收标准

- [ ] 每个内部构建派生并嵌入可审计、单调递增的 Host runtime SemVer；
- [ ] 新 Bridge 自动请求旧 Leader 让位并由当前打包 Host 接管；
- [ ] 轮换不删除或重建用户持久数据；
- [ ] Provider Catalog 来自新 Leader，十个官方入口完整可见；
- [ ] 降级客户端不能替换较新 Leader。
