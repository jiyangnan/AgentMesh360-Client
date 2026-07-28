# AgentMesh360 P4 R3 E1 分发服务 Preflight v1

状态：Cycle 62 零外部资源、零凭据、零网络请求的阻断式预检；P4 E1 实际分发演练
尚未获批、尚未执行

本文把正式生产准备计划中的 P4 R3 固定为机器可检查的 provenance 输入、非生产
Trust 边界、客户端消费契约、不可变发布顺序、故障矩阵、停止条件和批准卡。它不会
创建 origin、对象存储、Registry、DNS/TLS、账号或凭据，不会上传、发布、调用
Provider、消耗 credits 或产生费用。

机器 Schema：
[`../../schemas/agentmesh360-distribution-preflight-v1.schema.json`](../../schemas/agentmesh360-distribution-preflight-v1.schema.json)

默认 blocked 模板：
[`../templates/distribution-preflight-v1.json`](../templates/distribution-preflight-v1.json)

本地验证器：
[`../../tools/distribution-preflight/validate-distribution-preflight.mjs`](../../tools/distribution-preflight/validate-distribution-preflight.mjs)

## 1. P3 到 P4 的真实交接边界

P3 R2 E0 已产生 retention-safe receipt，并证明四个 Agent 可以双构建、测试签名和
逐字节复验。但 P3 的批准要求销毁临时 Publisher 和完整构建边界，因此：

- P3 只留下 commit、版本、typed digest、比较结果与销毁状态；
- Artifact、Envelope、Host bundles、Release Manifest 和 Registry candidate
  没有作为可上传文件保留；
- P2 与 P3 的测试私钥都已销毁，不能恢复或复用；
- P3 E0 PASS 不关闭生产 R2，也不授权任何 E1 基础设施。

P4 不能把摘要证据冒充可上传对象。未来实际 E1 演练必须在独立批准中固定新的
staging Release Set、非生产 Root/Publisher、Trust 注入方式、外部资源、凭据、请求
上限、销毁/清理窗口和证据位置。

默认模板固定绑定：

- P3 rehearsal ID：`release_provenance_e0_20260728_0001`；
- P3 receipt 摘要：
  `sha256:946bd98a4279430493cd80fae357f2c95b7ab7de624bcbabe2424248eefc0940`；
- 候选 commit：`e1ef8db19dc58a2c9cec19ac34f7e1966d741b7c`；
- executor commit：`5d97f0bf4c48de6e2ac40a3ed4066b5455361294`；
- `productionR2Closed=false`、`p3ArtifactsRetained=false`；
- E1 Release Set 固定为 `requires_approval`。

## 2. 强制阻断态

模板和 Schema 固定：

- `environment=e1`；
- `workPackage=p4_r3`；
- `authority=none`；
- `approvalStatus=not_approved`；
- `executionStatus=blocked`；
- `externalResourcesAllowed=false`；
- staging origin、TLS、对象存储、Registry store、凭据范围、owner、abort owner、
  cleanup window 全部为 `requires_approval`；
- 网络请求、Provider 请求、credits 与 currency cost 全部为 `0`。

Schema 和 validator 不接受调用方把 blocked 模板改成真实 endpoint、已批准凭据、
已创建资源或已完成状态。获批执行必须产生独立 execution receipt，不能覆盖模板
伪造完成。

## 3. 当前客户端消费契约

P4 必须复用现有消费者，不新造一套更宽松的下载协议：

| 契约 | 当前值 |
| --- | --- |
| 生产 origin host | `packages.agentmesh360.com` |
| 生产 Trust/Registry endpoint | 仍为 `None` |
| embedded Publisher Trust | 仍为 `None` |
| URL | HTTPS、精确 origin、无 credentials/query/fragment |
| redirect | 禁止 |
| Trust Bundle 上限 | 64 KiB |
| Registry 上限 | 1 MiB |
| Release Manifest 上限 | 1 MiB |
| Envelope 上限 | 64 KiB |
| Artifact 上限 | 32 MiB |
| Metadata MIME | `application/json` |
| Artifact MIME | `application/vnd.agentmesh.package`、`application/zstd`、`application/x-zstd`、`application/octet-stream` |
| Metadata timeout | connect 5 秒、total 15 秒 |
| Artifact timeout | connect 10 秒、total 90 秒 |
| 时间与回退 | 使用 Core trusted server time；只允许仍有效且已验签的 LKG |

E1 不能直接填充生产常量。staging 客户端如何注入隔离 Root、Publisher 与 endpoint
必须在实际批准前完成独立设计与审查，并保证不会进入正式客户端默认信任。

## 4. 不可变对象与发布顺序

每个 staging Release Set 的以下对象必须使用不可变名称，并在上传后重新读取、按
SHA-256 逐字节核对：

1. Artifact；
2. Envelope；
3. Host bundles；
4. Host projection；
5. Release Manifest。

固定顺序为：

```text
生成并复验 Release Set
  -> 上传不可变对象
  -> 逐对象回读并核对 digest / MIME / size
  -> 发布并复验 staging Trust Bundle
  -> 最后原子发布 Registry
  -> 从客户端消费者重新拉取并核对
```

禁止原地覆盖已有对象或同 revision Registry。若任一内容、摘要、MIME、origin、
Trust sequence 或 Registry revision 不一致，必须在 Registry 发布前停止；已经上传
但尚未被 Registry 引用的对象保持不可发现，随后按批准的清理策略处理。

撤回 Registry 不能删除用户已有本地数据，不能静默降级到未签名版本，也不能原地
替换已经发布的 Release。

## 5. 故障矩阵

未来 E1 必须逐项执行，不得只做 happy path：

| 场景 | 预期结果 |
| --- | --- |
| 404 | 使用有效 LKG；无有效 LKG 时 unavailable |
| timeout | 使用有效 LKG；无有效 LKG 时 unavailable |
| truncated response | 拒绝新响应并保留有效 LKG |
| response too large | 拒绝新响应并保留有效 LKG |
| wrong content type | 拒绝新响应并保留有效 LKG |
| redirect | 拒绝新响应并保留有效 LKG |
| digest mismatch | 拒绝新响应并保留有效 LKG |
| signature mismatch | 拒绝新响应并保留有效 LKG |
| expired remote metadata | 拒绝过期新响应并保留仍有效的 LKG |
| Registry rollback | 拒绝旧 revision 并保留更新的 LKG |
| same-revision equivocation | 拒绝不同文档并保留 LKG |
| valid LKG + transport failure | 正常提供有效 LKG |
| invalid/expired LKG | unavailable，失败关闭 |
| Registry 前只有部分对象 | 客户端不可发现半发布版本 |

任何一项没有实际证据都命中 `fault_matrix_incomplete`，不能写成 R3 通过。

## 6. 日志与证据边界

服务日志只允许 release ID、公开版本、object class、typed digest、状态、HTTP
状态类别和非个人 role alias。不得保留：

- 账号 ID、邮箱或个人身份；
- BYOK、Token、Authorization header、Cookie 或 staging credential；
- Prompt、模型响应、用户文件或本机路径；
- raw Trust Bundle、raw Registry、raw signature；
- 带 credential/query/fragment 的 endpoint；
- 原始部署命令或完整环境变量。

仓库内 evidence 只记录 origin alias，不记录 endpoint URL。真实 endpoint、资源 ID、
凭据和清理入口只允许存在于获批的访问受控操作环境。

## 7. 精确批准卡

未来执行 P4 前，批准至少要完整给出：

```text
Action: execute P4 R3 E1 isolated distribution rehearsal
Environment: E1
Release Set: exact source/toolchain/package versions and rebuild/signing authority
Staging Trust: exact non-production Root/Publisher generation, injection and destruction
External resources: exact origin, DNS/TLS, object storage and Registry resources
Credentials: exact least-privilege credential scope and storage
Maximum network requests: exact bounded count
Provider / requests / credits / currency cost: none / 0 / 0 / 0
Start and stop window: exact
Rollback target: exact Registry withdrawal, object cleanup and credential revocation
Abort owner: non-personal role alias
Evidence retention: exact access-controlled location and retention period
Approval receipt: explicit
```

“继续开发”、P3 批准或普通 GitHub push 权限都不能替代这张批准卡。

## 8. 停止条件

任一项命中立即停止，不自动扩大范围：

- `approval_missing`
- `p4_release_set_unapproved`
- `staging_trust_unapproved`
- `external_resource_unapproved`
- `credential_scope_unapproved`
- `origin_or_tls_drift`
- `immutable_object_mismatch`
- `object_overwrite_possible`
- `registry_publish_order_violation`
- `fault_matrix_incomplete`
- `lkg_semantics_violation`
- `evidence_policy_violation`
- `cleanup_failure`

## 9. 本地验证

```bash
node tools/distribution-preflight/validate-distribution-preflight.mjs \
  docs/templates/distribution-preflight-v1.json

node --test tools/distribution-preflight/*.test.mjs
```

验证通过只说明 P4 的阻断边界和未来验收矩阵已被机器表达，不表示 E1 资源、Trust、
Release Set、上传、Registry、故障注入或清理已经执行，也不关闭生产 R3 或开放 P5-P8。
