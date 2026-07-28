# P3 R2 E0 Release Provenance 技术演练记录

状态：**通过（仅 E0 技术演练）**

完成时间：2026-07-28

## 1. 范围与批准边界

本轮只执行获批的 P3 R2 E0 本机离线技术演练：

- 候选提交固定为 `e1ef8db19dc58a2c9cec19ac34f7e1966d741b7c`；
- 只允许生成 1 个临时测试 Publisher；
- 对 Deploy、Future、Job、LectureCast 四个 Agent 分别执行 A/B 双构建；
- 对已完成构建前比较的 8 份 signing request 执行 8 次测试签名；
- 只保留非秘密 provenance evidence；
- 不使用生产密钥、外部服务、Provider、credits 或付费资源；
- 结束时销毁测试私钥并移除构建目录、临时 worktree 和完整临时边界。

本轮不授权生产 Root/Publisher、外部 Registry/origin、上传、发布、staging、
canary、Apple 签名/公证或 P4-P8。

## 2. 冻结输入

| 类别 | 冻结提交 |
| --- | --- |
| 候选源码 | `e1ef8db19dc58a2c9cec19ac34f7e1966d741b7c` |
| 最终执行器 | `5d97f0bf4c48de6e2ac40a3ed4066b5455361294` |
| Deploy Agent | `781599f9b8ab1374f8a9b018da553d425cd23e13` |
| Future Agent fixture | `5d97f0bf4c48de6e2ac40a3ed4066b5455361294` |
| Job Agent | `ed8f1c683d5d3bf8103de4c12f9f395e82251e9a` |
| LectureCast Agent | `688dd61ab1910fec03383f18bdfaee74ed67ecac` |

执行器与候选提交分开记录。三个首方 Agent 均从冻结提交建立临时 detached
worktree，避免其源仓库后续提交改变本次打包输入。

## 3. 执行结果

| Agent | 版本 | 构建 | 签名请求 | 签名复验 | Host bundles | 十类输出 A/B 比较 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Deploy Agent | 0.1.1 | 2 | 2 | 2 | 0 | 10/10 逐字节一致 |
| Future Agent | 1.0.0 | 2 | 2 | 2 | 2 | 10/10 逐字节一致 |
| Job Agent | 0.4.7 | 2 | 2 | 2 | 2 | 10/10 逐字节一致 |
| LectureCast Agent | 0.4.0 | 2 | 2 | 2 | 3 | 10/10 逐字节一致 |

汇总结果：

- 测试 Publisher 生成次数：1；
- 签名操作次数：8；
- 四个 Agent 的 Artifact、Envelope、finalize receipt、Host bundles、Host
  projection、package file manifest、Registry record、Release Manifest、
  signature result、signing request 均完成 A/B 逐字节比较；
- 8 次签名均通过 H1 验签与 H2d1-H2d3 离线装配；
- Registry record 只使用 `.invalid` HTTPS 绑定，不发生网络访问或发布。

## 4. 两次失败关闭与修复

正式成功前发生两次 pre-key 失败关闭，均在调用 `generate` 之前停止，因此没有额外
生成 Publisher：

1. 执行器 `fd71b3a19c96af79964a759a696e98f440f6e7bd` 的首个 Package build
   失败只返回固定标签，无法定位根因。修复为只保留最后一条、路径脱敏、最长
   320 字符的 bounded diagnostic，并加入回归测试；
2. 执行器 `9ef6f2581cf4c94c8453e4187031d9d4aaf20228` 暴露 runner 使用旧参数
   `--definition-dir/--source-root`，而正式 CLI 接受
   `--definition/--source`。修复参数绑定并增加完整 argv 合约测试；
3. 最终执行器 `5d97f0bf4c48de6e2ac40a3ed4066b5455361294` 完成全部演练。

两次失败均未写成功 receipt，并移除了临时边界、两个 build root、候选 worktree
与三个 source worktree。异常没有被误记为 PASS，也没有消耗获批的唯一 key 生成次数。

## 5. 销毁与恢复

成功 receipt 确认：

- 测试 Publisher 私钥已执行 overwrite、fsync、unlink，再递归移除临时边界；
- `privateFilesRemaining = 0`，仓库未检测到私钥材料；
- 两个 build root、一个候选 worktree、三个 source worktree 和临时边界均已移除；
- 仓库根 `target/` 不存在；
- Trust 状态恢复为空，生产 Trust/Registry 常量保持为空；
- 没有创建生产 key、发布生产 Registry 或使用外部 authority。

上述方法是本机文件层面的尽力销毁，不声称提供存储介质级取证安全擦除保证。

## 6. 验证与复核

- release provenance receipt validator：通过；
- Node release-provenance 回归：27/27 通过；
- Package authoring/CLI/Package 模块回归、Rustfmt、Clippy：通过；
- receipt JSON 解析、Schema、diff check：通过；
- retained evidence 中的 PEM、公钥/签名原文、绝对本机路径和个人身份扫描：零；
- 演练后临时边界、根 `target/`、临时 worktree：零；
- 生产 Trust/Registry 三个常量仍为空。

Kimi 因账户周期额度不足暂不可用。用户已明确要求在其恢复并另行通知前停止调用
Kimi，因此本轮最终 gate 由主 Agent 采用完整 diff 复核、负向回归、receipt
逐字段对账、秘密扫描和清理状态复验完成；该结论不冒充 Kimi 独立审查。

## 7. 保留证据与结论边界

- 机器可读 receipt：
  [`2026-07-28-p3-release-provenance-e0.json`](2026-07-28-p3-release-provenance-e0.json)
- receipt 文件摘要：
  `sha256:946bd98a4279430493cd80fae357f2c95b7ab7de624bcbabe2424248eefc0940`
- receipt 权限：`0600`
- receipt 大小：13,827 bytes

本记录只关闭 **P3 R2 E0 技术演练**。它证明本机离线工具链可按冻结输入完成四 Agent
双构建、测试签名、逐字节复验、provenance 留证和失败关闭清理；它不关闭生产 R2，
不表示任何 Agent Package 已上传或发布，也不开放 P4-P8。

下一项仍按既定顺序评估 P4 R3 E1。创建隔离 origin、对象存储、Registry 或 staging
凭据属于新的外部资源与 authority，必须另行获得精确批准后才能执行。
