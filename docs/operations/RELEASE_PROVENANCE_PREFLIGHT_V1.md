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

## 8. 获批执行的无私钥装配路径

实际演练使用 `agentmesh360-package-author` 的三段式路径：

1. `build`：从 Agent manifest/authoring manifest 构建 Artifact、signing request
   和 Host projection；
2. 隔离 signer worker：只在获批临时目录生成一个测试 Publisher，逐项签署
   signing request，并在演练结束时销毁私钥；
3. `assemble-release`：只接收 Artifact、request、signature result、公开 key 与
   Host projection，执行 finalize、H1 复验、Host bundle export、Release Manifest
   assembly 和未发布 Registry binding。

`assemble-release` 不接受私钥参数，不写 embedded/cached Trust。它创建一个仅当前
进程有效的 public-key Trust store；输出目录必须是新目录，失败会删除整个目录，
成功会删除验证 staging。E0 Registry URL 使用 HTTPS `.invalid` 地址，只绑定
canonical 文档，不发生网络请求。

隔离 signer 通过 canonical parent 约束 target；已有私钥只允许
`O_NOFOLLOW` 打开后由 `fstat` 确认 regular file、`0600` 和 4 KiB 上限，避免
`lstat` 后的 symlink swap。macOS `/var` 与 `/private/var` alias 由 parent
`realpath` 归一化，不对未归一化字符串做错误前缀比较。

候选内容仍来自批准的 clean detached commit；新增 executor 必须先独立通过测试、
Kimi 审查并冻结 commit/digest。最终 receipt 同时记录 candidate commit 与 executor
commit，防止用工具补齐掩盖候选漂移。

## 9. Execution receipt 与 runner

获批执行证据使用：

- `schemas/agentmesh360-release-provenance-receipt-v1.schema.json`
- `tools/release-provenance/validate-release-provenance-receipt.mjs`
- `tools/release-provenance/run-e0-release-provenance.mjs`

receipt 只保留 commit、tool version、公开 ID/version、role alias、typed tree digest、
file count、比较/复验/销毁状态。它固定一个 Publisher、8 次签名、四 Agent 与十类
输出，不允许 raw public key、raw signature、绝对路径、个人身份或原始命令。

runner 必须收到 `--execute-approved-p3-e0` 才能运行。即使有 ack，也必须先完成全部
source/lock/production boundary 检查、两个隔离 executor build 与四 Agent 的
Artifact/signing request/Host projection A/B 比较；任一步失败都不会调用
`generate`。生成后任一异常进入同一 finally 清理：尝试销毁私钥、移除 detached
worktree 和完整临时 boundary，不写成功 receipt。

为控制磁盘，A/B Cargo target 仍是两个独立 root，但按 A 构建、复制执行器、删除 A
target，再按相同步骤构建 B；二者不会同时驻留。Package/Release A/B 输出保留到比较
结束，随后随 boundary 一并删除。

首方 source 参数标识本机仓库，但 runner 不直接使用其可前进的当前 checkout。
它先确认仓库 clean 且冻结 commit object 存在，再在临时 boundary 中为 Deploy、
Job、LectureCast 分别创建该 commit 的 detached worktree。这样同仓库其他产品的
新提交不会改变 P3 Artifact；三个 source worktree 必须在 receipt 前全部移除。

## 10. 2026-07-28 E0 执行结果

获批的 P3 R2 E0 技术演练已经完成。四个 Agent 均通过 A/B 双构建和十类输出逐字节
比较；全窗口只生成 1 个临时测试 Publisher，共完成 8 次签名与复验，随后销毁私钥并
移除两个 build root、candidate worktree、三个 source worktree 和完整临时边界。

机器 receipt 与中文复核记录：

- [`tabletops/2026-07-28-p3-release-provenance-e0.json`](tabletops/2026-07-28-p3-release-provenance-e0.json)
- [`tabletops/2026-07-28-p3-release-provenance-e0.md`](tabletops/2026-07-28-p3-release-provenance-e0.md)

该结果只关闭 P3 R2 E0 技术演练，不关闭生产 R2，不表示 Registry 已发布，也不开放
P4-P8。下一步 P4 R3 E1 的任何外部 origin、对象存储、Registry 或 staging authority
都必须另行精确批准。
