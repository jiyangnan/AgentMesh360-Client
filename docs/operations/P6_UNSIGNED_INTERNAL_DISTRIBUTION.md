# P6 未签名内部体验版发行说明

## 当前决策

在 AgentMesh360 Client 达到足以承担 Apple Developer Program 年费的用户规模前，
macOS 客户端使用未签名、未公证的内部体验版。该阶段服务于产品开发、创始人自用和
明确知情的种子测试用户，不等于生产 R4 Desktop Distribution，也不允许对外宣称
“Apple 已验证”或“正式发布”。

内部体验版必须同时满足：

- 只从已经推送到 `origin/main` 的 clean commit 构建；
- 构建环境不存在 Apple signing、notarization 或发布凭据；
- `electron-builder` 固定 `identity: null`、`--publish never`；
- 只生成当前架构的一份 DMG 和一份 ZIP；
- 在删除 unpacked `.app` 前逐字节核对其中的 Host 与 release Host；
- 每个包必须注入单调 AgentMesh360 Host runtime SemVer，并用打包 Host
  `--version` 逐字核对版本与 commit，确保安装后自动替换旧常驻 Leader；
- 同目录生成 `unsigned-internal-build-v1.json` 与 `SHA256SUMS`；
- receipt 明确记录 Developer ID、公证、自动更新、外部上传和生产 R4 均为 false；
- 不请求 Provider，不消耗 AgentMesh credits，不访问 Apple 公证服务；
- 构建使用的 Cargo 临时目录在结束后删除，不恢复仓库根 `target/`。
- DMG 明确关闭 `writeUpdateInfo`；Electron Builder 对 ZIP 强制生成的临时
  `.blockmap`、unpacked `.app` 与 builder 调试文件在核验后删除，只保留分发所需
  四个文件；固定 `.icon-icns/` 图标转换缓存也会删除，其他未知目录继续失败关闭。

默认命令：

```bash
cd desktop
npm run build:mac
```

`build:mac` 当前等同 `build:mac:internal`。执行器会拒绝脏工作区、未推送 commit、
Apple/CSC 凭据和发布 Token；任何失败都会删除本次不完整输出。成功产物位于：

```text
desktop/dist/internal/<version>-<commit12>-<architecture>/
```

## 单包留存规则

内部体验版只保留最新一份已验证包，避免历史 DMG、ZIP 和构建中间产物持续占用磁盘：

- `~/Downloads` 只保留最新的
  `AgentMesh360-Internal-Test-<date>-<commit7>-<architecture>/` 交付目录；
- `desktop/dist/internal/` 只保留与该交付包对应的最新构建证据目录；
- `desktop/dist/` 根目录不得残留重复的 DMG、ZIP、blockmap、unpacked App、
  builder 调试文件或图标转换缓存；
- 必须先让新包通过 receipt verifier、`SHA256SUMS`、DMG 校验和交付副本复验，
  再删除上一份包；新包验证失败时保留上一份可用包；
- 每次清理都在项目进展中记录保留版本、删除数量和最终磁盘状态。

该规则只清理安装包和构建产物，不删除用户已经安装到 `/Applications` 的客户端，
也不触碰客户端账户、Provider、Agent 或会话数据。

## 下载与校验

分发时必须把 DMG、ZIP、`unsigned-internal-build-v1.json` 和 `SHA256SUMS` 放在同一
目录。测试用户先通过 AgentMesh360 官网或对应 Git commit 核对版本和 SHA-256，
再执行：

```bash
shasum -a 256 -c SHA256SUMS
```

仓库侧可进一步验证 receipt 与实际字节：

```bash
node tools/desktop-internal-build/verify-unsigned-internal.mjs \
  /absolute/path/to/unsigned-internal-build-v1.json
```

校验失败、缺少 receipt/`SHA256SUMS`、文件名或大小不符、Artifact 被替换或出现
symlink 时不得安装。

`SHA256SUMS` 只能证明下载字节与公布值一致；如果安装包和校验文件来自同一个已被
攻破的下载渠道，它不能替代 Developer ID 的发布者身份。因此内部体验版必须让用户
从独立的官网或仓库提交核对摘要，不能把同目录校验文件描述为 Apple 信任或生产
供应链签名。

## macOS 首次打开

测试用户双击后若 macOS 阻止启动，应只对 AgentMesh360 单个应用执行：

1. 尝试打开一次 AgentMesh360；
2. 打开“系统设置 → 隐私与安全性”；
3. 在安全提示处确认应用来源和刚刚下载的版本；
4. 点击“仍要打开”，再完成一次确认。

不要求用户执行 `spctl --master-disable`，也不要求开启全局“任何来源”。如果系统没有
提供单应用“仍要打开”、下载来源不可信或 SHA-256 不匹配，应停止安装。

## 明确关闭的能力

本阶段不做：

- Developer ID 申请、证书发现、签名或证书托管；
- Apple notarization、stapling 或 Gatekeeper 通过声明；
- 自动更新、静默更新或静默降级；
- GitHub Release、对象存储、官网自动上传或外部 cohort 推送；
- 把内部 receipt 当成生产签名、供应链 authority 或 R4 证据；
- 要求普通用户全局关闭 macOS 安全保护。

当进入规模化公开发行时，必须回到
[`P6_DESKTOP_CANDIDATE_PREFLIGHT_CHECKLIST.md`](P6_DESKTOP_CANDIDATE_PREFLIGHT_CHECKLIST.md)
重新冻结 Developer ID、签名、公证、Hardened Runtime、entitlements、更新渠道、
rollback 和完整 18 场景矩阵；内部体验版不能跳过这些门。

## 已验证的首份内部构建

2026-07-30 已从 clean pushed commit `9db201f43a49...` 完成 arm64 构建：

- ZIP SHA-256：
  `7409150d8b82466c28813fda6964b465054d88f30e7c9b9900bf8b4a0e4164d6`；
- DMG SHA-256：
  `c2cfcd1f024e39a52f253aa95e17684778afa23490ed5ed8e5d16c6702ca996f`；
- `hdiutil verify`、receipt verifier 与 `SHA256SUMS` 均通过；
- ZIP/DMG 内含 arm64、可执行的 `Resources/bin/agentmesh360-host`；
- Bundle ID 为 `com.agentmesh360.client`，版本为 `0.1.0`；
- 没有 Developer ID、Team ID 或 notarization；Mach-O 的 linker ad-hoc 标记不构成
  Apple 发行签名，deep codesign 校验失败是本阶段的预期边界；
- 构建临时 Cargo target、unpacked App、blockmap 与图标转换缓存均已清理。

这些摘要只绑定上述 commit 的本地内部产物；未来任何重新构建都必须产生新的 receipt
与摘要，不能沿用本节的数值。

## 最新内部体验版

2026-07-31 已从 clean pushed commit
`20773b4c39c7876e0cff8d8b52bb7aa76fa4680e` 构建并交付当前 arm64 内部体验版：

- receipt：`desktop_internal_p6_20773b4c39c7_arm64`；
- Desktop `0.1.1`，Host runtime `1000.1.1785478545001 (20773b4)`；
- DMG SHA-256：
  `a30deceae0ca110ded20bdedb1f2f2392f6e8be646062cfe5977688d44c17616`；
- ZIP SHA-256：
  `9c02e09628e8b031f68a135be8ccda8eb241b37300e82c50d43e8cd1d63d2d32`；
- receipt verifier、`SHA256SUMS`、`hdiutil verify`、构建/交付副本逐字节比较和 ZIP
  Host/`app.asar` inventory 全部通过；
- 本地交付目录：
  `~/Downloads/AgentMesh360-Internal-Test-2026-07-31-20773b4-arm64/`；
- 新包验证后才删除 `461f1af` 上一包和旧构建证据；当前 Downloads 与
  `desktop/dist/internal` 各只保留这一份，仓库根 `target/` 不存在；
- 本次仍未签名、未公证、未上传、未请求 Provider，Apple/credits/Provider 费用均为
  0。

隔离安装、首次启动、Login Item 与打包 Host 的后续矩阵见
[`P6_UNSIGNED_INTERNAL_INSTALL_LIFECYCLE.md`](P6_UNSIGNED_INTERNAL_INSTALL_LIFECYCLE.md)。
