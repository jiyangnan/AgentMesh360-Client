# P4 R3 E1 隔离分发演练执行授权

状态：已获用户精确批准；执行器基线正在冻结；付费资源、非生产 Trust、Release Set、
上传、故障矩阵与清理证据尚未执行。本文和同名 JSON 只证明授权边界，不证明 E1
已经通过，也不关闭生产 R3。

## 1. 已批准结果

- 环境：`E1`
- 工作包：`P4 R3`
- 执行窗口：72 小时，不允许自动延长
- 预计成本：`1.15 USD`
- 硬预算上限：`3.00 USD`
- Provider 推理请求：0
- credits：0
- 外部网络请求上限：500
- 生产 authority：未授予

预算模型使用一个 SGP1 `s-1vcpu-1gb` Droplet 的 72 小时小时价，以及 Spaces
`5 USD/月` 按 720 小时折算的 72 小时成本：

```text
0.00893 × 72 + 5 × 72 / 720 = 1.14296 USD
```

它低于 `1.15 USD` 预计值，并为 `3.00 USD` 硬上限保留异常缓冲。禁止付费备份、
付费快照、CDN、自动扩容和未列出的资源。

## 2. 基础设施边界

演练复用现有 DigitalOcean 账号、SGP1 区域和既有部署能力，但不复用或改写任何
生产 Droplet，也不复用其他产品的 staging Droplet。

新建资源最多五项：

1. 一个 1 GiB、1 vCPU、25 GiB、无备份的隔离 Droplet；
2. 一个只存不可变 Release 对象的 Spaces bucket；
3. 一个只存 Trust Bundle 与 Registry metadata 的 Spaces bucket；
4. 一个 Cloudflare staging DNS 记录；
5. 一个隔离 HTTPS origin 运行单元。

两个 bucket 禁用 CDN；origin 使用 Caddy 管理 TLS，并允许在 E1 测试通路中执行
已批准的故障注入。生产 origin、生产 DNS 和客户端生产常量不可修改。

## 3. Release Set 与 Trust

Release Set 绑定 P3 非秘密 receipt、冻结候选和四个 Agent：

- Deploy Agent `0.1.1`
- Future Agent fixture `1.0.0`
- Job Agent `0.4.7`
- Lecturecast Agent `0.4.0`

P3 的 Artifact 与私钥均未保留，因此 E1 必须重新从冻结来源完成 A/B 双构建。
只允许生成一个非生产 Root 和一个非生产 Publisher，均位于本机隔离临时边界；
不得复用 P2/P3 私钥，不得把 Root 或 Publisher 私钥传到云端。客户端只通过显式
E1 测试 harness 注入非生产 Trust，生产 Trust 继续为空。

## 4. 凭据与留存

- DigitalOcean 使用既有 operator context；
- Spaces publisher 只获得目标 bucket 的读、写、删权限并留在本机安全存储；
- origin reader 只获得目标 bucket 的只读权限，远端文件权限必须为 `0600`；
- 结束时撤销所有 staging Spaces key；
- 仓库 evidence 不记录凭据、Authorization header、原始 Trust/Registry、
  endpoint URL、资源 ID、IP、个人身份、本机绝对路径、用户内容或 Provider 内容。

当前只读核验已确认账号 active、SGP1 支持目标 Droplet 规格，且现有生产资源不会
被复用。Spaces key 控制面在当前 API 上返回不可用状态，因此实际创建前还需要通过
已登录控制台完成同等最小权限操作；这不扩大已批准范围。

## 5. 执行与清理顺序

1. 冻结并推送可校验的授权/执行器 commit；
2. 创建隔离基础设施和最小凭据；
3. 生成 E1 Root/Publisher，完成四 Agent 双构建与签名复验；
4. 先发布不可变对象，逐项回读摘要；
5. 发布 Trust Bundle，最后原子发布 Registry；
6. 执行 14 项故障、反回滚和 LKG 矩阵；
7. 先撤回 Registry，再销毁 Droplet、bucket、DNS、凭据和私钥；
8. 复验生产 Trust/Registry 仍为空，只保留非秘密 receipt。

任意异常都必须先清理再决定是否重试；不能提高预算、延长窗口、增加资源、启用
Provider/credits 或触碰生产资源。

## 6. 机器校验

机器授权见
[`2026-07-28-p4-distribution-e1-authorization.json`](2026-07-28-p4-distribution-e1-authorization.json)。

```bash
node tools/distribution-e1/validate-distribution-authorization.mjs \
  docs/operations/tabletops/2026-07-28-p4-distribution-e1-authorization.json

node --test tools/distribution-e1/validate-distribution-authorization.test.mjs
```

Schema、validator 与测试会拒绝预算/窗口漂移、生产复用、资源扩容、Provider/credits、
未知字段、重复 JSON key、symlink、超限文件，以及 URL、IP、本机路径或私钥材料进入
授权 receipt。
