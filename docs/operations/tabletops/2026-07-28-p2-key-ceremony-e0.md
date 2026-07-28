# P2 E0 测试密钥技术演练报告

状态：本机技术演练已通过；生产 R1、生产 custody 与生产 key ceremony 均未关闭

本报告是
[`ceremony_e0_20260728_0001`](2026-07-28-p2-key-ceremony-e0.json)
的可读摘要。机器 receipt 只保存非秘密 ID、SHA-256 摘要、sequence、结果码和清理
证明，不保存私钥、公钥原文、签名原文、个人身份、绝对路径或原始命令。

## 1. 授权与执行边界

- 授权 receipt：`approval_p2_e0_20260728_0001`；
- 环境与 authority：`E0` / `test_keys`；
- 绑定源码：`c68c2d133a8ab3fa30cc57f783fbaa8311eee5ec`；
- 外部服务、Provider 请求、credits 与费用：全部为零；
- 初始材料：一个临时 Root、两个临时 Publisher；
- Root 轮换：在同一隔离窗口内额外生成一个短暂继任 Root，只用于接棒验证；
- 所有测试私钥必须在 receipt 写入前销毁，Trust 必须恢复为空。

该授权不包含生产 Root/Publisher、E1/E2、Registry endpoint、Apple 凭据、真实订阅、
BYOK 请求、canary 或发布。

## 2. 工具与保留证据

本轮新增：

- `agentmesh360-key-ceremony-receipt-v1` 严格 JSON Schema；
- 隔离 key worker：私钥只存在于系统临时目录和短生命周期子进程；
- E0 runner：复用 Rust 当前的 Ed25519、canonical Trust payload、sequence 和
  Publisher 状态契约；
- receipt 验证器与 retention 扫描器：拒绝 unknown field、重复 JSON key、symlink、
  私钥字段、公钥/签名原文、个人身份和绝对路径。

worker 对销毁目标执行覆盖、`fsync`、unlink，runner 再递归删除并验证整个临时目录
不存在。由于 APFS/SSD 的 copy-on-write 与磨损均衡，报告明确
`forensicSecureEraseGuaranteed=false`；这里证明的是应用命名空间与可访问材料清除，
不声称介质级法证擦除。

Kimi 首轮复核后又补强：

- worker 要求 ceremony boundary 直接位于系统临时目录，所有 target 的真实父目录
  仍在 boundary 内；越界、非 `.pk8` 与 symlink-parent 请求都有无破坏负测试；
- repo PEM 扫描覆盖 PKCS#8、RSA、DSA、EC、ENCRYPTED 与 OPENSSH 私钥头；
- Trust key 使用与 Rust 相同的码元序，时间固定为严格 UTC 毫秒格式，公开 Ed25519
  点在进入 JWK/验签前先完成压缩点解码有效性检查；
- bare 64-hex 值不再允许进入保留证据，所有 digest 使用 `sha256:` 类型前缀；
- runner 按实际完成的 checkpoint 逐项登记 16 个 scenario 和 6 个 negative check，
  缺一项就不能构造未来 receipt。

## 3. 证据信任模型

本 receipt 是 `audited_local_runner` 在 fail-before-write 流程结束后产生的结构化
attestation，不是一个脱离 runner、源码和独立复核即可验证的密码学证明：

- 为避免保留公钥、签名与临时文档原文，digest 的输入已经销毁，因此
  `digestInputsIndependentlyVerifiable=false`；
- 本次 receipt v1 的场景结果依赖获审计 runner 完整执行，因此
  `scenarioOccurrenceStandaloneProof=false`；
- validator 可以拒绝未知字段、bare 64-hex、秘密/路径载体、未销毁状态与生产 R1
  越权声明，但不能仅从 receipt 重演已销毁的 ceremony。

这两个 `false` 是必须保留的审查限制，不能被调用方改成 `true`。实际发生性由绑定的
source commit、runner 的 fail-before-write 结构、自主回归和 Kimi 只读交叉复核共同
支撑。

## 4. 正向演练结果

四份临时私钥均完成生成和公开摘要导出，未进入主进程、仓库、客户端、普通 CI 或
receipt：

| alias | 用途 | 最终状态 |
| --- | --- | --- |
| `root_initial` | 签署 sequence 1-4 与 Root 接棒声明 | 已销毁 |
| `root_successor_transient` | 验证 Root overlap/接棒后的 sequence 5 | 已销毁 |
| `publisher_a` | 初始 Publisher、丢失恢复、退役与吊销 | 已销毁 |
| `publisher_b` | overlap 后的接任 Publisher | 已销毁 |

Trust sequence 演练：

| sequence | Root | Publisher 状态 | 结果 |
| --- | --- | --- | --- |
| 1 | initial | A active | 验签通过 |
| 2 | initial | A + B active | overlap 通过 |
| 3 | initial | A retired、B active | 正常退役通过 |
| 4 | initial | A revoked、B active | 泄漏/吊销通过 |
| 5 | successor | A revoked、B active | Root 接棒通过 |

Publisher A 与初始 Root 都完成“建立隔离备份 → 删除原件 → 恢复 → 重新签名并独立验签”
的丢失恢复验证。16 个预检场景全部为 `passed`。

## 5. 失败关闭结果

以下输入均被拒绝：

- 过期的 active Publisher；
- 过期的 Trust Bundle；
- 已吊销 Publisher 再次成为 active；
- sequence 回滚；
- 同 sequence 不同文档的异文；
- 未知或已移除的 Root。

第一次启动在生成任何 key 前被仓库私钥扫描器的自指 PEM 字面量误报阻断。修复为
非自指 marker 构造并增加回归后，确认无临时目录、无 receipt、无 key 生成，才重新
执行实际演练。该事件证明停止条件在材料生成前生效，没有产生待清理的异常 key。

## 6. 清理与生产边界

receipt 写入前再次确认：

- 临时目录不存在、私钥文件剩余数为零；
- 仓库变更中没有私钥扩展名或 PEM 私钥标记；
- `TrustedRootStore::embedded()` 仍为空；
- `EMBEDDED_PUBLISHER_TRUST_BUNDLE`、`PRODUCTION_TRUST_BUNDLE_URL` 与
  `PRODUCTION_REGISTRY_URL` 仍为 `None`；
- 保留证据没有私钥、公钥/签名原文、个人身份、绝对路径或原始命令。

因此本轮只关闭 P2 的 E0 测试密钥技术演练子项。生产 R1 仍需独立人员、批准的
offline/external custody、生产 Root/Publisher ceremony 与生产级轮换/恢复审计；
不能用本 receipt 填入任何生产常量。

## 7. 独立交叉测试

本机 Kimi CLI session `session_e8117ef9-14a9-4879-bb86-58fdf529830d` 两轮只读
复核。首轮 3 Medium / 4 Low 全部进入代码、测试与 review-limitations 闭环；第二轮
独立复跑 41/41、receipt/preflight CLI、JSON、link/fence、diff、生产关闭常量、
临时目录、根 `target/` 与泄漏扫描，最终 Blocker/High/Medium/Low 全零并 PASS。

Kimi 没有修改文件、执行实际 ceremony/worker 成功动作、生成/读取 key、访问
Keychain/Provider、运行 Cargo/npm/Electron 或创建根 `target/`。
