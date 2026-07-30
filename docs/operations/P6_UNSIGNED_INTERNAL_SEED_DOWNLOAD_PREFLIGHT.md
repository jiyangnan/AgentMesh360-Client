# P6 未签名内部版种子下载预检

## 目的

把“本机产物已经通过隔离生命周期测试”和“允许上传并让种子用户下载”分成两个
独立状态。当前预检只证明下一轮真实演练需要冻结哪些条件，不授予上传、公开访问、
真实账号登录、Provider 使用、AgentMesh credits、Apple 服务或生产修改权限。

## 当前状态

- authority：`none`
- approval：`not_approved`
- execution：`blocked`
- channel / cohort / device / window / abort owner：均未配置
- network / upload / Provider / credits / Apple service / cost：全部为 0
- production R4、P7、P8：仍未满足或未授权

机器可读模板位于
`docs/templates/desktop-seed-download-preflight-v1.json`。它按 SHA-256 绑定
Cycle 130 的留存验收证据、build receipt、ZIP 和 DMG，任何字节或 provenance
漂移都会失败关闭。

## 真实执行前必须单独冻结

1. 下载渠道 provider、hostname、路径和 artifact 可见性；
2. 只允许当前 DMG/ZIP 与独立 checksum，禁止自动更新；
3. 明确知情的账号数、设备别名和未签名风险告知；
4. 起止时间、Abort Owner、上传请求数与费用上限；
5. 非秘密证据留存规则和渠道撤回、对象删除、设备清理方法；
6. 禁止全局关闭 Gatekeeper；只允许用户对这一应用使用“隐私与安全性 → 仍要打开”；
7. 浏览器下载后必须真实观察 quarantine、首次拦截、单应用放行、订阅门、
   Login Item 用户选择、卸载清理和渠道撤回。

在这些字段获得独立批准前，九个真实场景全部保持 `blocked`。预检校验器本身只有
本地普通文件读取、SHA-256 和严格 JSON 校验能力，不含网络、subprocess、Keychain、
上传或外部服务能力。

## 校验

```bash
node tools/desktop-seed-download-preflight/validate-desktop-seed-download-preflight.mjs
node --test tools/desktop-seed-download-preflight/*.test.mjs
```

预期输出必须显示 `authority=none`、`approvalStatus=not_approved`、
`executionStatus=blocked`、`networkRequests=0`，下一动作只能是取得独立种子下载
canary 授权。
