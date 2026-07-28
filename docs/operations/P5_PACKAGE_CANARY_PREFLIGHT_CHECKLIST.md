# P5 Package Canary 阻断式预检清单

状态：`authority=none`、`executionStatus=blocked`

本清单只把 P5 的进入条件、客户端契约、场景矩阵和批准卡变成可复核输入。它不授权
访问订阅服务、Keychain、Provider、Package Origin，也不授权创建外部资源、恢复
P4 已销毁的测试私钥或修改生产 Trust/Registry 常量。

## 1. 当前输入事实

- P4 E1 隔离分发演练已经通过并完整清场；
- P4 证据不关闭生产 R3；
- P4 Root、Publisher、Spaces、Origin、Registry 和本机临时状态均未保留；
- 当前只有 R1/R2 E0 技术演练、R3 E1 隔离演练和 R6 本地基线，尚未形成针对本次
  P5 E1 release chain 的完整进入证据；生产 R1、R2、R3 仍未关闭；
- P5 没有专用内部账号、订阅、BYOK、费用、cohort 或时间窗授权。

以上任一事实被改写为“已批准”或“已保留”，预检必须失败。

## 2. 执行前必须另行提供

1. 针对本次 E1 release chain 可复核的 R1/R2/R3 和适用 R6 前置证据；这不要求
   把 E1 偷换成 E2，也不能声称生产门已经关闭；
2. 精确 Release ID、Package Set 和不可变 Registry revision；
3. 专用内部账号和真实有效订阅，只在批准窗口内使用；
4. BYOK Credential Ref、Provider 和模型；证据不得记录 Key；
5. network request、Provider request、credits 和货币费用四类硬上限；
6. canary 操作人、cohort、开始/停止时间、rollback target 和 Abort Owner；
7. 轮换/吊销、Registry 撤回、LKG、安装 reconcile 和清场步骤；
8. 非秘密 evidence retention 位置及最终凭据撤销/轮换要求。

缺少任一项时只能保持 `blocked`，不能自动补默认值或沿用旧授权。

## 3. 固定场景

预检固定 21 项：订阅有效/无效、账户切换、BYOK 路由、Provider 鉴权/瞬时失败/
能力不匹配、预算停止、新装、同权限更新、权限扩张拒绝/批准、内容篡改、
Registry 回退/异文、Trust 过期/Publisher 吊销、安装中断 reconcile、Package
rollback、Host Skill 投影、Root 轮换、Publisher 轮换/吊销和 Registry 撤回。

真实执行时每项必须有独立结果和恢复证据，不能从本模板的 `blocked` 推断通过。

## 4. 运行本地验证

```bash
node tools/package-canary-preflight/validate-package-canary-preflight.mjs \
  docs/templates/package-canary-preflight-v1.json
node --test tools/package-canary-preflight/validate-package-canary-preflight.test.mjs
```

这两个命令只读仓库文件和本地临时测试目录，不访问网络、不读取 Keychain、不调用
Provider，也不产生 credits 或费用。

## 5. 停止边界

若发现跨账户可见/写入、权限批准可重放、静默 Provider fallback、重复不可逆
mutation、费用超限、rollback/LKG/清场失败，或证据包含账号、Credential、BYOK、
Prompt、响应、Tool 内容、URL、绝对路径和原始 Trust/Registry，必须停止，不扩大
cohort，不写 `canary_passed`。
