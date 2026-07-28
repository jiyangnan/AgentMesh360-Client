# AgentMesh360 P3 R2 E0 Release Provenance Preflight v1

状态：Cycle 60 零新 key、零外部 authority 的阻断式预检；P3 实际双构建与测试签名
尚未获批、尚未执行

本文把正式生产准备计划中的 P3 R2 固定为机器可检查的输入、输出、Agent 矩阵、
签名边界、停止条件和批准卡。它不会运行 Cargo build、生成或读取 key、签名、
finalize、构造候选 Registry、上传、发布或写仓库根 `target/`。

机器 Schema：
[`../../schemas/agentmesh360-release-provenance-preflight-v1.schema.json`](../../schemas/agentmesh360-release-provenance-preflight-v1.schema.json)

默认 blocked 模板：
[`../templates/release-provenance-preflight-v1.json`](../templates/release-provenance-preflight-v1.json)

本地验证器：
[`../../tools/release-provenance/validate-release-provenance-preflight.mjs`](../../tools/release-provenance/validate-release-provenance-preflight.mjs)

## 1. 为什么不能直接复用历史构建

H2d0-H2d4 已证明本地 Authoring、Artifact、Host bundles、Release Manifest 与
Registry projection 的代码路径可以工作，历史首方测试也曾使用测试 key 完成双构建。
这些记录不能直接关闭当前 P3：

- 当前候选必须绑定新的 clean source commit、`Cargo.lock` 摘要与工具链版本；
- H2d1-H2d4 已改变 H2d0 初始 Artifact/Release 字节，历史 SHA-256 只是当时的开发
  证据；
- P2 的 Root/Publisher 私钥及备份已经销毁，不能恢复或复用；
- P3 要求三种首方 Agent 加一个不在内置 Catalog 的动态 Agent 同时完成当前
  Release reference 核对；
- 生产 R1 仍未满足，P3 只能使用独立批准的新 E0 测试 Publisher。

## 2. 强制阻断态

默认模板固定：

- `environment=e0`；
- `workPackage=p3_r2`；
- `authority=none`；
- `approvalStatus=not_approved`；
- `executionStatus=blocked`；
- source commit、lock digest、Rust toolchain 均为 `requires_execution_*`；
- signer mode 与 test Publisher key ID 均为 `requires_approval`。

Schema 和 validator 不接受调用方把这些值改成真实 commit/digest、approved、
completed 或任何 signer authority。获批后的 execution receipt 必须是另一份
独立证据，不能修改 blocked 模板伪造。

## 3. Source freeze 与两次隔离构建

未来执行前必须在同一批准窗口内记录：

1. clean source commit；
2. `Cargo.lock` typed SHA-256；
3. `rustc`、`cargo` 和必要工具版本；
4. Rust 实现当前 11 个数值 Schema version 与 2 个 canonical payload ID；
5. 两个独立 build root 与两个独立 output root。

预检不发明聚合 Schema 名称，而是逐项绑定代码里的真实常量：

- Authoring、signing request/result、public key、Host skill plan/projection、
  package signature/file manifest、Host skill export 与 Agent Release 均为 version `1`；
- Registry snapshot 为 version `2`；
- package signature canonical payload 为
  `agentmesh360-package-signature-v1`；
- Registry canonical payload 为 `agentmesh360-package-registry-v2`。

执行角色使用非个人 alias 并保持分离：`build_operator` 负责两次隔离构建，
`test_signer_operator` 只接收 signing request 并调用获批 signer，
`independent_reviewer` 独立核对摘要、receipt 与销毁结果。角色 alias 不代表
生产双人 custody 已满足。

两次构建必须使用相同输入，且逐字节比较十类输出：

| output class | R2 绑定目的 |
| --- | --- |
| `artifact` | 客户端持久 Agent Package |
| `package_file_manifest` | Artifact 文件 inventory 与摘要 |
| `signing_request` | 外部 Publisher signer 的确定性请求 |
| `signature_result` | 获批测试 signer 的返回 |
| `envelope` | Artifact 与 Publisher 的签名信封 |
| `finalize_receipt` | Authoring 本地复验结果 |
| `host_projection` | Website/宿主审核 projection |
| `host_bundles` | 每个真实 Host bundle |
| `release_manifest` | 客户端/宿主共同 Release reference |
| `registry_record` | 尚未发布的候选 Registry record |

任一字节、文件数、文件名、version、Publisher、Host 集合、入口或摘要不同都命中
`build_output_mismatch`。两个 build root 必须位于仓库外的隔离临时目录；若仓库根
出现 `target/`，命中 `repository_target_created` 并停止，避免再次占用大量磁盘。

## 4. Agent 矩阵

矩阵按公开 ID 固定排序：

| Agent / package / version | source class | 目的 |
| --- | --- | --- |
| `deploy-agent` / `com.agentmesh360.deploy-agent` / `0.1.1` | `first_party` | 验证零 Host Adapter 仍可形成客户端 Release |
| `future-agent` / `com.agentmesh360.future-agent` / `1.0.0` | `dynamic_fixture` | 沿用 H2d1 fixture，验证未来新增 Agent 不依赖内置 Catalog 特判 |
| `job-agent` / `com.agentmesh360.job-agent` / `0.4.7` | `first_party` | 验证客户端与宿主 Skill 同源 |
| `lecturecast-agent` / `com.agentmesh360.lecturecast-agent` / `0.4.0` | `first_party` | 验证客户端与宿主 Skill 同源 |

三个首方 Agent 的真实源码位置、账户或本机绝对路径不能进入模板、receipt 或 Kimi
输入；获批执行时由本机 operator 在受控环境中解析。

## 5. 签名 boundary

- 只允许 Ed25519；
- Builder 不持有私钥，只产生非秘密 signing request；
- P2 private material 固定 `p2PrivateMaterialReusable=false`；
- production key 固定 `productionKeyAllowed=false`；
- Repository、Builder 和 evidence 中的 private material 全部固定为 `false`；
- 新测试 Publisher 的 key ID、signer mode、存储/销毁方式与窗口必须由新批准卡给出。

历史 P2 批准只覆盖 key ceremony，不覆盖 P3 Artifact signing。P3 需要一张新的
精确批准卡，至少固定：

```text
Action: execute P3 R2 E0 dual build and test signing
Environment: E0
Source commit / package versions: exact
Credentials: one newly generated test Publisher only
Signer mode and storage: exact
External resources: none, or separately approved exact list
Provider / requests / credits / currency cost: none / 0 / 0 / 0
Start and stop window: exact
Rollback: destroy test signer and remove both build roots
Evidence retention: exact access-controlled location
Approval receipt: explicit
```

## 6. 停止条件与证据

任一项命中即中止，不能自动重试：

- `approval_missing`
- `build_output_mismatch`
- `dirty_source_tree`
- `evidence_policy_violation`
- `private_material_boundary_violation`
- `repository_target_created`
- `source_or_toolchain_drift`

保留证据只允许公开 ID、版本、typed `sha256:` digest、工具版本、状态与非个人 role
alias；禁止私钥、公钥/签名原文、绝对路径、个人身份、原始命令、Token、Provider
凭据或用户内容。

## 7. Preflight 验证

```bash
node tools/release-provenance/validate-release-provenance-preflight.mjs \
  docs/templates/release-provenance-preflight-v1.json
```

验证通过只表示 P3 的阻断边界已被机器表达，不表示 source 已冻结、双构建/签名已经
执行、R2 已满足、Registry 已生成或任何 staging/canary/production authority 已开放。
