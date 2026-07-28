# AgentMesh360 E0 Key Ceremony Preflight v1

状态：Cycle 58 P2 无 authority 设计基线继续保留；Cycle 59 已完成独立批准的 E0
测试 key 技术演练，但生产 R1 与生产 key ceremony 继续关闭

本文固定 E0 测试 Root/Publisher key ceremony 的职责、存储边界、sequence、停止
条件、批准卡和证据要求。Preflight 模板本身不会生成、导入、恢复、轮换、吊销或
销毁任何 key，也不是批准 receipt；Cycle 59 的实际 receipt 作为独立证据保存。

机器可读 Schema：
[`../../schemas/agentmesh360-key-ceremony-preflight-v1.schema.json`](../../schemas/agentmesh360-key-ceremony-preflight-v1.schema.json)

默认模板：
[`../templates/key-ceremony-preflight-v1.json`](../templates/key-ceremony-preflight-v1.json)

本地验证器：
[`../../tools/key-ceremony/validate-key-ceremony-preflight.mjs`](../../tools/key-ceremony/validate-key-ceremony-preflight.mjs)

Cycle 59 非秘密 receipt 与可读报告：

- [`../operations/tabletops/2026-07-28-p2-key-ceremony-e0.json`](tabletops/2026-07-28-p2-key-ceremony-e0.json)
- [`../operations/tabletops/2026-07-28-p2-key-ceremony-e0.md`](tabletops/2026-07-28-p2-key-ceremony-e0.md)

## 1. 当前源码事实

P2 必须复用已经验证的信任格式，不另造平行签名协议：

| 事实 | 当前契约 |
| --- | --- |
| 算法 | Root 与 Publisher 均使用 Ed25519 |
| Root Store | 生产 `TrustedRootStore::embedded()` 仍为空 |
| Publisher Bundle | strict JSON；包含 `sequence`、`rootKeyId`、时间窗、排序后的 key records 和 Root signature |
| Publisher 状态 | `active`、`retired`、`revoked`；运行时只装载当前有效的 `active` key |
| 反回滚 | Bundle sequence 必须大于零且不低于已接受 minimum sequence |
| Canonical payload | `agentmesh360-publisher-trust-v1` 固定文本载荷；key 按 `keyId` 严格递增 |
| Package signing | Authoring 只产生无秘密 signing request；外部 signer 返回 signature 与 public-key document，本地 finalize 重新验签 |
| Registry | Root-signed Registry 必须绑定同一 `rootKeyId` 和 Publisher Trust sequence |

因此 preflight 不允许自定义算法、自由文本 payload、未排序 key、sequence 复用或把
私钥交给 Builder/Client/普通 CI。

## 2. Preflight 的强制关闭态

`key-ceremony-preflight-v1.json` 固定为：

- `environment = e0`；
- `ceremonyClass = test_key_rehearsal`；
- `authority = none`；
- `approvalStatus = not_approved`；
- `executionStatus = blocked`；
- `algorithm = ed25519`。

Schema 不允许把这些字段改成 approved、running、completed 或 production。批准后
执行的真实 receipt 必须进入受访问控制的证据系统，不能通过修改本 preflight 模板
伪造。

## 3. 角色分离

Preflight 只保存非个人化 role alias，不保存姓名、邮箱或账户：

| Role alias | 职责 | 禁止 |
| --- | --- | --- |
| `release_owner` | 批准 E0 范围、窗口、回滚和停止条件 | 不能单人完成 Root 操作 |
| `independent_witness` | 逐步见证 public receipt、备份和销毁 | 不能替代 Release Owner |
| `incident_owner` | 命中停止条件时宣告中止并隔离材料 | 不能降低严重级别或改写证据 |
| `signer_operator` | 操作获批的离线 Root/外部 Publisher signer | 不能修改待签 payload |
| `build_operator` | 产生无秘密 signing request 和摘要 | 不能接触任何私钥 |

真实人员只能出现在访问受控的批准/值班系统中；仓库模板继续只保存 alias。

## 4. Custody 边界

固定原则：

- Root 私有材料只允许位于批准的 `offline_removable_media`；
- Publisher 私有材料只允许位于批准的 `external_signer`；
- 备份份数、介质、保管角色、恢复窗口和销毁方式分别映射到
  `backupCopyCount`、`backupMedia`、`backupCustodianRoles`、
  `recoveryWindow` 和 `destructionMethod`，当前全部固定为
  `requires_approval`，本计划不替业务负责人设定；
- Repository、Client、普通 CI 和 evidence 中的 private material 标志必须全部为
  `false`；
- 仓库、终端输出、日志、截图和 Kimi 输入只能出现 key ID、公开摘要、状态、sequence
  和非秘密 receipt ID。

一旦发现材料出现在未批准位置，立即命中
`unexpected_private_material_location`，本轮设为 aborted。

## 5. Sequence 与状态演练

模板预留两个 Publisher ID，用于证明 overlap rotation，不代表已生成 key：

| Trust sequence | 预期 Publisher 状态 | 目的 |
| --- | --- | --- |
| 1 | A `active` | 首个测试 Bundle |
| 2 | A `active` + B `active` | 新旧 key overlap |
| 3 | A `retired` + B `active` | 正常退役；旧 key 不再接受新安装/更新 |
| 4 | A `revoked` + B `active` | compromise/紧急吊销 |

四个 sequence 必须严格递增。相同 sequence 的不同文档必须拒绝，不能用覆盖旧对象
模拟轮换。Root loss/recovery 是独立失败演练；不能用旧 Root 临时签一个“新 Root”
冒充恢复。

## 6. 执行前批准卡

生成任何临时测试 key 前，必须由用户提供第 8 节格式的精确批准卡，至少固定：

```text
Action: generate E0 test Root and two Publisher keys; run rotation/revocation rehearsal
Environment: E0
Release/Package/Desktop version: not applicable / explicit rehearsal ID
External resources: exact list or none
Credentials involved: newly generated test keys only
Provider and model: none
Maximum requests / credits / currency cost: 0 / 0 / 0
Canary accounts/devices/cohort: none
Start and stop window: explicit
Rollback target: destroy test material and restore empty trust state
Abort owner: explicit Incident Owner
Evidence retention location: access-controlled location
Approved by / approved at: explicit receipt
```

当前模板中的 `startStopWindow = requires_approval` 与
`approvalReceipt = not_present` 是硬阻断，不是待自动填写的默认授权。
`releasePackageDesktopVersion = not_applicable_use_ceremony_id` 表示本次 E0 不绑定
产品版本，第 8 节卡片中的“explicit rehearsal ID”必须与顶层 `ceremonyId` 一致。

## 7. 获批后的演练清单

以下步骤继续作为每次 E0 演练的固定顺序，不包含可复制的 key-generation 命令：

1. 核对批准卡、role separation、E0 隔离目录和材料清单；
2. 记录 `scope_approved` 事件和非秘密批准 receipt；
3. 生成测试 Root，分离 private material，只导出公开 key document 与 digest；
4. 生成 Publisher A/B，分别导出 public-key document；
5. 产生 sequence 1 Bundle，独立复验 canonical payload 与 Root signature；
6. 依次演练 Publisher sequence 2 overlap、sequence 3 retire、sequence 4 revoke；
7. 演练 Publisher loss/recovery、compromise、key expiry 与紧急吊销；
8. 对旧 sequence、同 sequence 异文、未知 Root、过期 Bundle 和 revoked Publisher
   做失败关闭验证；
9. 演练 Root loss/recovery、compromise、overlap rotation 与紧急吊销；Root loss
   不直接升级为生产恢复设计；
10. 销毁/撤销测试材料，复核仓库、日志、截图、终端和证据没有 private material；
11. 记录完成/中止事件，Kimi 独立复核后才决定 P2 是否满足 E0 退出条件。

## 8. 停止条件

任一项命中即停止，不能自动重试：

- `approval_missing`
- `role_separation_missing`
- `storage_boundary_unverified`
- `unexpected_private_material_location`
- `sequence_or_identity_mismatch`
- `receipt_validation_failed`

此外，任何真实 key、signature、public-key 原文、个人身份或绝对本机路径进入仓库/
证据摘要时，按
[`RELEASE_INCIDENT_RESPONSE_RUNBOOK_V1.md`](RELEASE_INCIDENT_RESPONSE_RUNBOOK_V1.md)
的秘密泄漏流程处理。

## 9. Preflight 验证

```bash
node tools/key-ceremony/validate-key-ceremony-preflight.mjs \
  --preflight docs/templates/key-ceremony-preflight-v1.json
```

验证器限制为 128 KiB regular UTF-8 JSON，拒绝 symlink、重复 object key、未知字段、
缺失字段、非法/重复/乱序 ID、非单调 sequence，以及任何 approval/execution/authority
升级。CLI 错误不输出绝对输入路径或文件内容。

验证通过只说明“执行前约束已被机器表达”，不代表批准、key 已生成、ceremony 已开始
或 R1 已满足。

## 10. P2 当前退出边界

Cycle 59 已在独立批准窗口内真实完成 E0 临时测试 key、备份、轮换、retire、revoke、
丢失、泄漏、过期、恢复与销毁，并生成 retention-safe receipt。该技术演练只满足
P2 的 E0 子项，不关闭生产 R1，因为：

- E0 使用的是本机临时目录与测试 key，不是批准的 offline removable media 或
  external signer；
- `release_authorizer`、`rehearsal_operator` 与本机 Kimi 只能形成技术演练的职责
  交叉，不能冒充生产双人 ceremony；
- 测试 Root/Publisher 及其备份已经销毁，Trust 已恢复为空；
- 生产常量、endpoint、Registry、canary 和发布能力仍全部关闭。

生产 Root/Publisher ceremony 仍是另一张批准卡，不能沿用 E0 测试授权。

## 11. Receipt 证据限制

Cycle 59 receipt v1 固定两个不能上调的限制：

- `digestInputsIndependentlyVerifiable=false`：销毁原文后，审查者不能只靠摘要重新
  计算其输入；
- `scenarioOccurrenceStandaloneProof=false`：receipt 是获审计 runner 的完成
  attestation，不是脱离源码与独立复核即可证明发生性的密码学证明。

因此 digest 统一使用 `sha256:` 类型前缀并拒绝 bare 64-hex；未来 runner 也必须在
每个实际 checkpoint 完成后登记 scenario/negative check，缺项时禁止写 receipt。
这些限制不会把测试 key、原始 public key/signature 或临时文档重新带入证据。
