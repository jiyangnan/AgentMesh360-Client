# P6 未签名内部版隔离安装与生命周期

## 目标与边界

本检查点验证已经生成的 `unsigned_internal_only` DMG/ZIP 是否能够在一台真实 Mac
上完成隔离复制、首次运行、单实例窗口恢复、Login Item 开关和打包 Host 持久恢复。
它不覆盖 `/Applications` 或 `~/Applications` 中的现有 App，不使用真实账号、订阅、
Provider、credits 或 Apple 服务，也不把内部版升级成生产 R4。

执行器在下列任一情况停止：

- 当前仓库不是 clean 且已推送到 `origin/main` 的完整 commit；
- `/Applications/AgentMesh360.app` 或
  `~/Applications/AgentMesh360.app` 已经存在；
- 以 root 运行，或环境中存在构建器已识别的 Apple/CSC/发布凭据；
- build receipt、DMG/ZIP、大小、SHA-256 或四文件产物边界不匹配；
- DMG 无法只读挂载，DMG/ZIP 的 Host 或 `app.asar` 不一致；
- Bundle、Host、未签名边界、窗口、单实例、Login Item、后台退出或持久 Host
  任一自动场景失败；
- Login Item 没有恢复为关闭、DMG 没有卸载或隔离状态不能完整销毁。

## 固定自动矩阵

1. strict receipt 与四文件 Artifact 边界；
2. `hdiutil verify`、DMG 只读挂载和临时 `Applications` 复制；
3. ZIP 解压并与 DMG 的 Host、`app.asar` 摘要一致；
4. Bundle ID/版本、arm64/x64 Host 与可执行位；
5. 嵌套本机听写 Helper 的 Bundle、隐私声明、架构、可执行位和系统框架边界；
6. Developer ID 缺失、deep codesign 与 Gatekeeper assessment 不通过，明确进入手动
   单应用放行边界；
7. 独立 HOME/userData/state 下首次启动为 `signed_out`，Host 不提前运行；
8. 关闭窗口后第二实例退出并让原主进程恢复窗口；
9. 打包态 Login Item 开启、读取、关闭，并以关闭状态结束；
10. 未登录的 `--agentmesh360-background` 不建窗口、不启 Host 并自动退出；
11. 打包 Host 对 Job、Lecturecast、Deploy 三个 Agent 的固定 Main Session、
    UI Bridge detach、Leader 重连、崩溃替换与恢复；
12. App/Helper/Host、socket、DMG mount 和隔离目录全部清理。

执行器只在 `127.0.0.1` 的临时端口打开短时 DevTools，用于调用 preload 已有的脱敏
IPC；子进程环境采用白名单，不继承 Provider、Apple、发布或其他秘密。端口随 App
退出关闭，不进入产品配置。

## 运行

先确认当前没有安装同名 App，再使用绝对 receipt 路径：

```bash
node tools/desktop-internal-install/run-isolated-lifecycle.mjs \
  /absolute/path/to/unsigned-internal-build-v1.json
```

真实运行会挂载 DMG、启动 GUI App、短暂注册再移除自己的 Login Item，并启动打包
Host。它必须在普通登录用户的图形会话中、沙箱外运行。成功只输出不含本机路径、账号、
PID、端口或凭据的单行 JSON。

## Gatekeeper 人工步骤

本机直接构建和复制的 App 通常没有浏览器下载产生的 quarantine 属性，因此自动矩阵
只能确认：

- 没有 Developer ID/Team ID；
- deep codesign 不通过；
- Gatekeeper assessment 不通过；
- receipt 与说明要求单应用“隐私与安全性 → 仍要打开”，不要求全局关闭
  Gatekeeper。

真正从官网下载后的 quarantine 首次打开仍需在种子用户机器上人工确认一次。该人工
步骤不得用 `spctl --master-disable`、不得启用全局“任何来源”，也不得记录用户系统
设置或其他已安装 App。它是内部体验版的已知交互，不是生产签名/公证通过。

## 首次真实执行结果

2026-07-30，冻结 executor commit `15507ae62a58...` 对 Artifact commit
`9db201f43a49...` 的 arm64 `0.1.0` 完成正式执行：

- 自动矩阵 11/11；
- Login Item 最终关闭；
- 测试 App/Helper/Host、socket、DMG mount 和隔离目录为 0；
- Provider 请求、AgentMesh credits、Apple service、上传和生产 mutation 为 0；
- Developer ID、notarization 与生产 R4 仍为 false；
- `manualGatekeeperActionRequired=true`，
  `globalGatekeeperDisableRequired=false`。

该结果绑定上述两个 commit；未来 Artifact 或执行器变化后必须重新执行，不能沿用。
