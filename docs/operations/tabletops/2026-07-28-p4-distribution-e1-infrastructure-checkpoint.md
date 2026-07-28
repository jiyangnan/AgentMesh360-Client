# P4 R3 E1 隔离基础设施检查点

状态：E1 执行中；两个 SGP1 Spaces bucket、两组最小权限 key、唯一 1 GiB Droplet
和 DNS-only staging 记录已创建；origin executor 已通过本地契约测试，实际
Caddy/TLS 部署、Release Set、Registry、14 项故障矩阵和最终销毁尚未完成。
本文不是 E1 PASS 或生产 R3 关闭证据。

## 1. 冻结基线

- 授权执行器 commit：`635b87b`
- 授权：72 小时、预计 `1.15 USD`、硬上限 `3 USD`
- 区域：SGP1
- Provider 请求：0
- credits：0
- 生产资源变更：0

付费 mutation 只在授权 commit 推送到 GitHub main 后发生。现有 AgentMesh 生产、
其他生产和其他产品 staging Droplet 都只读识别并排除。

## 2. 已完成资源

- Spaces subscription：1
- Standard Storage bucket：2
- CDN：均关闭
- active limited-access key：2
- revoked failed key：1
- Droplet：1
- DNS record：1，DNS-only
- origin：0

控制台显示 Spaces subscription 为约 `0.007 USD/hour`。两个 bucket 共享同一
subscription，72 小时估算约 `0.50 USD`，仍与批准预算模型一致。

## 3. 最小权限

Publisher key：

- 只能访问两个 E1 bucket；
- 权限为 Read/Write/Delete；
- 只保存在本机 mode `0600` 临时凭据边界；
- 不进入仓库、聊天证据、命令参数或云端 origin。

Origin Reader key：

- 只能访问两个 E1 bucket；
- 权限为 Read；
- 只在部署阶段以 mode `0600` 注入隔离 Droplet；
- 结束时撤销。

初次 Reader key 与 S3 secret 配对复验返回 `SignatureDoesNotMatch`。它被立即永久
撤销后重新生成；没有提升权限。重建 key 通过 Publisher 写/读、Reader 读、
Reader 写入被 403 拒绝、Publisher 删除的完整探针，探针对象已移除。

唯一 Droplet 绑定 executor `028fc9f`，API 复验为 active、SGP1、1 GiB、1 vCPU、
25 GiB、无 backup/monitoring。Cloudflare 记录不启用 proxy，避免 edge cache、
redirect 或 WAF 改写分发语义。真实 hostname、IP 和资源 ID 只在 mode `0600`
临时 cleanup state 中。

## 4. 本地执行器

新增无依赖 SigV4 Spaces client：

- 只允许 `sgp1` 和批准的 E1 bucket 命名边界；
- canonical path/query、SHA-256 payload、SigV4 header 与 15 秒 timeout；
- credential 文件必须是 bounded、regular、non-symlink、mode `0600`；
- Publisher 与 Reader access ID 必须不同；
- 错误只保留 HTTP status/S3 code，不打印 secret、URL、bucket 或 access ID。

新增 Droplet boundary runner：

- 只允许 `/private/tmp` 的直接 E1 隔离目录；
- 本机生成临时 Ed25519 SSH transport key，私钥 mode `0600`；
- cloud-init 固定 Ubuntu 24.04、SSH password disabled、Node/curl/CA/UFW；
- 防火墙只开放 22/80/443；
- Droplet 固定 SGP1、`s-1vcpu-1gb`、无 backup/monitoring；
- 创建前要求 clean、精确 executor commit，并复验 cloud-init/public-key digest；
- 创建后先保留 mode `0600` cleanup state，再验证 1 GiB/1 vCPU/25 GiB/active；
- 销毁 runner 同时撤销 Droplet 和临时 SSH private material。

新增 Spaces-backed origin 与部署器：

- Node origin 只监听 loopback，由 Caddy 暴露 TLS；
- Trust/Registry/immutable object 分别映射两个 Spaces bucket；
- metadata、Artifact 与 MIME 都有独立上限，redirect/query/fragment 不开放；
- 14 项 fault route 必须携带精确临时 token；日志只记录 method、route class、status；
- Caddy 不启用 access log，DNS 为直连 origin；
- systemd 使用独立无登录用户、`NoNewPrivileges`、`ProtectSystem=strict` 和空 capability；
- 部署前复验 Droplet/DNS/Spaces suffix 与 clean executor commit，部署后必须通过
  公网 HTTPS health 和系统服务 active 检查。

首次实际 deploy 在任何 SSH 或远端 mutation 前 fail-close：实现把当前 origin
executor commit 错误地拿去匹配 Droplet 创建 executor commit。临时 live state
逐项正确；现已把 Droplet provenance 和 origin provenance 分开固定并补回归测试，
修复 commit 推送前不重试。

第二次实际 deploy 仍在 SSH 前 fail-close：本机 TUN/Fake-IP DNS 把公共与权威
UDP/53 A 查询改写为 `198.18.0.0/15`，导致预检看不到真实权威答案。Cloudflare
控制台记录仍是批准 Droplet IP、DNS-only，生产 DNS 未变化。部署器现已：

- 仅把 `198.18.0.0/15` 识别为 Fake-IP；
- 在系统 DNS 不精确匹配时，用无 redirect、有限时、有限输出的 Cloudflare
  HTTPS DNS 复验；
- 只接受查询 hostname 的精确 IPv4 A answer；
- HTTPS DNS 或解析异常时继续 fail-close，不允许跳过 IP 绑定。

实际 staging HTTPS DNS 复验已得到 `approved_dns_match=true`；复验输出不包含
hostname、IP、endpoint URL 或凭据。远端仍未收到 Reader key，Caddy/origin
仍未安装。

随后部署器首次 SSH 连接已接受临时公钥，但 DigitalOcean Ubuntu 镜像要求 root
首次登录修改密码，非交互命令在 cloud-init 检查前被 PAM 拒绝。没有传输 Reader
key、origin 文件或安装 Caddy。该空载 Droplet 已立即销毁并通过 API 复验，
旧临时 SSH 私钥已覆盖后删除；当前 active E1 Droplet 为 0，staging DNS 暂时
指向已销毁地址。

恢复实现禁用 root SSH，改用密码锁定、仅公钥的 `agentmesh-operator`；所有远端
特权命令统一显式执行 `sudo --`，SCP 只写 `/tmp`。新增一次性的 `record-dns`
动作，从批准 Droplet 名称推导 hostname，避免替代实例状态被手工拼接。重建必须
在 active Droplet 为 0 后开始，始终满足最多一个 E1 Droplet。

## 5. 验证与下一步

- Spaces SigV4/client：6/6
- Droplet boundary：6/6
- authorization：13/13
- origin service：5/5
- origin deployment boundary：11/11
- E1 联合定向：40/40
- 实际 least-privilege S3 probe：PASS，probe object removed

operator/DNS 状态恢复定向测试与 origin deploy 合计 18/18。

Cycle 67 commit `be108f4` 推送后，已在 active E1 Droplet 为 0 的前提下创建
唯一替代实例。API 复验 count=1、SGP1、1 GiB、1 vCPU、25 GiB、无 backups。
同一 staging A record 只更新 content，仍为 DNS-only/TTL 1 分钟；控制台和
Cloudflare HTTPS DNS 均精确匹配。新的 cleanup state 由 `record-dns` 写入并保持
mode `0600`。当前部署器只接受替代 Droplet executor `be108f4`。

下一步先冻结并推送当前 origin executor，再部署 Caddy TLS 和 Spaces-backed
origin。Release Set、非生产 Root/Publisher、Registry
与故障矩阵必须继续按顺序执行，不能跳到 P5。
