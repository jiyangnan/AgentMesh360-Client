# P6 R4 Desktop Candidate 阻断式预检清单

状态：`authority=none`、`approvalStatus=not_approved`、
`executionStatus=blocked`

本清单只固化 P6 的当前桌面分发差距、R4 安全合同、18 项验收场景和未来批准卡。
它不授权读取 Apple 账号或 Keychain，不授权检查/导入 Developer ID 证书，不授权
签名、公证、上传、创建更新渠道、安装候选或产生费用。

## 1. 当前已经具备

- 桌面版本为 `0.1.0`，bundle ID 为 `com.agentmesh360.client`；
- Electron 与 electron-builder 已锁定，当前本地打包目标为 DMG 和 ZIP；
- Host binary 已作为 extra resource 进入桌面包；
- 已有 Login Item、后台无窗口启动、第二实例唤醒、持久 Host 与退出清理的源码和
  开发测试基础；
- P5 E1 Package canary 已完成并清场，临时云资源、Provider、Keychain、Host 和
  本机边界均归零；
- 生产 Package Trust/Registry 常量继续为空。

这些事实只代表开发基础，不代表 R4 或 Desktop Candidate 已完成。

## 2. 当前明确缺失

- 未验证 Apple Developer Program membership，也未读取任何签名身份；
- 未配置 Developer ID Application signing；
- 未显式配置 Hardened Runtime、主进程/子进程 entitlements 或最小权限复核；
- 未配置 notarization 与 ticket stapling；
- 未引入 `electron-updater`，也没有更新 provider、channel、metadata 或 LKG
  rollback 实现；
- 未固定候选 source commit、版本、architecture set、最低 macOS、测试设备/cohort
  和 rollback target；
- 仓库没有桌面 Release workflow；
- 本轮没有构建、签名、安装、启动或上传候选。

任一缺失项不得被模板改写成“已具备”。blocked 模板的作用是防止本地 DMG/ZIP 被
误称为正式候选。

## 3. Apple 与打包工具的当前外部要求

- Apple 要求在 Mac App Store 外分发的软件使用 Developer ID 签名；公证前必须采用
  有效 Developer ID 证书并启用 Hardened Runtime；
- 自定义公证工作流应使用 `notarytool`，通过后还要验证并按候选类型执行 ticket
  stapling；
- Hardened Runtime exception entitlement 只能按真实运行需要最小化加入，不能直接
  复制宽权限模板；
- electron-builder 可以配置 Developer ID signing、Hardened Runtime、
  entitlements 和 notarization；配置文件存在不等于拥有签名 authority；
- macOS 自动更新需要 ZIP/update metadata 与明确 publish provider，但具体 provider、
  channel、架构和验证/rollback 策略必须先独立评审，不能让 unsigned update 路径
  进入正式候选。

执行真实 P6 时必须重新核对官方最新要求，不把本清单中的工具行为当永久规范：

- [Apple：Signing Mac Software with Developer ID](https://developer.apple.com/developer-id/)
- [Apple：Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple：Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)
- [electron-builder：macOS notarization](https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/code-signing/notarization.md)

## 4. 未来批准卡必须一次性明确

1. 候选 environment、desktop version、冻结 commit 与 bundle ID；
2. architecture set 和最低支持 macOS；
3. 允许使用的 Developer ID certificate 边界与执行角色；
4. notarization credential 类型、保管位置、可执行动作和撤销方式；
5. 更新 provider、channel、对象命名、metadata、可见范围和撤回方式；
6. 上一个已验证版本和真实 rollback target；
7. 测试 Mac/device alias、cohort、开始/停止窗口和 Abort Owner；
8. 最大 Apple/update network requests 与费用上限；
9. 非秘密 evidence retention、notarization log 脱敏与最终凭据清理。

用户的“继续开发”、P5 Provider/基础设施授权或 GitHub 推送授权都不能替代这张卡。

## 5. 固定 18 项场景

1. 固定 commit/version/bundle 的候选构建；
2. 每个批准架构；
3. 主应用、Host 与全部 nested executable 的签名；
4. Hardened Runtime；
5. 最小 entitlement；
6. notarization acceptance 与脱敏日志复核；
7. stapling 与离线 Gatekeeper；
8. 干净安装和首次启动；
9. 二次启动与单实例；
10. Login Item 注册和用户选择；
11. 无窗口后台启动与窗口恢复；
12. 持久 Host 崩溃和 App 重启恢复；
13. 正常/强制退出；
14. 签名更新检查和下载；
15. 篡改/未签名更新拒绝；
16. 更新中断后的 LKG；
17. 版本 rollback 与兼容用户状态；
18. 卸载时 Host/Login Item 清理。

模板中的 18 项全部为 `blocked`；只有真实候选逐项执行并保留安全证据后才能变成
通过。

## 6. 本地验证

```bash
node tools/desktop-candidate-preflight/validate-desktop-candidate-preflight.mjs \
  docs/templates/desktop-candidate-preflight-v1.json
node --test \
  tools/desktop-candidate-preflight/validate-desktop-candidate-preflight.test.mjs
```

验证器只读仓库输入和测试临时目录，没有 network、Keychain、subprocess、Apple
service、签名或上传能力。
