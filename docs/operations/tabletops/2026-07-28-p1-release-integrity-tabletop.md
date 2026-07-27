# P1 Release Integrity E0 Tabletop

状态：2026-07-28 E0 文档演练已完成；不是 E1/E2 技术演练

## 1. 范围

- Release：`rel_p1_tabletop`
- Public version：`0.0.0-tabletop`
- Environment：E0
- Gate：R6 本地基线
- UTC execution window：`2026-07-27T16:21:00Z` 至 `2026-07-27T16:36:00Z`
- Facilitator：本轮主 Agent
- Simulated roles：Release Owner、Independent Witness、Incident Owner
- External resources：无
- Credentials / Provider / credits：无
- Production mutation：无

本演练只验证
[`RELEASE_INCIDENT_RESPONSE_RUNBOOK_V1.md`](../RELEASE_INCIDENT_RESPONSE_RUNBOOK_V1.md)
的决策顺序和 Release Event v1 表达能力，不模拟“已经拥有生产人员或系统”。

## 2. 注入场景

假设 E2 封闭候选阶段同时出现：

1. Registry revision `42` 被观察到两个不同文档；
2. 第二个文档引用一个尚不可用的 Artifact；
3. 该 Release 使用的 Publisher key 可能误签；
4. 管理员准备把最低客户端版本提高，以阻止旧客户端继续消费错误目录；
5. 观测存储间歇不可用，部分事件可能重复投递。

## 3. 决策过程

| 时间 | 决策 | Runbook 依据 | 结果 |
| --- | --- | --- | --- |
| T+0 | 按 SEV-0 宣告并停止 cohort 扩大 | 同 revision 异文 + 可能误签 | 不继续发布 |
| T+2 | 冻结 Registry，不覆盖 revision 42 | Playbook A | 保留原证据 |
| T+4 | 只允许有效且未过期 LKG；无 LKG 则失败关闭 | Playbook A | 不创建无签名修复 |
| T+6 | 把 Publisher 与 Root compromise 分开调查 | Playbook B/C | 不先吊销 Root |
| T+8 | 拒绝立即提高最低版本 | Playbook D | 避免无法更新客户端锁死 |
| T+10 | 观测缺失/重复时保持冻结 | §11 | 不把无事件当恢复 |
| T+12 | 恢复条件要求新 revision、新不可变对象、rollback 和独立复核 | §12 | 不自动回到候选阶段 |

## 4. 关键判断

### 4.1 为什么不是先发布 revision 42 的修正版

相同 revision 异文是 equivocation。原地替换会让不同客户端看到不同历史，破坏
反回滚与审计，因此必须使用新的不可变对象和更高 revision。

### 4.2 为什么不能立即吊销 Root

当前证据只指向 Publisher 可能误签。Root 吊销会影响整条 Package 信任链，并可能
要求 Desktop Root replacement；必须先区分 Publisher compromise 和 Root compromise。

### 4.3 为什么不能先强制最低版本

尚未验证安全自动更新与官方安装器恢复。提高最低版本可能让旧客户端既不能运行又
无法安全升级，因此先冻结高风险 mutation，保留恢复入口。

### 4.4 如何处理观测不可用

保持当前阶段和冻结状态。事件缺失、重复或时钟异常均不能推断操作成功；恢复必须从
原 authority 重新生成非秘密 receipt 并通过验证。

## 5. 事件证据

本演练只记录两个 E0 tabletop 事件：

[`2026-07-28-p1-release-integrity-tabletop.events.v1.jsonl`](2026-07-28-p1-release-integrity-tabletop.events.v1.jsonl)

事件不记录注入文档、URL、签名、设备、账户或错误原文。

## 6. 结果

E0 tabletop 通过以下本地基线：

- 立即停止条件明确；
- Publisher/Root 分流正确；
- Registry revision 不原地覆盖；
- LKG 不存在时失败关闭；
- 最低版本不先于恢复安装路径；
- 观测故障阻止阶段前进；
- 恢复不自动升级发布状态；
- 事件可以在无内容、无秘密情况下记录演练开始/完成。

## 7. 未关闭项

- 没有指定真实 Release Owner、Witness、Incident Owner 或联系方式；
- 没有 E1/E2 观测服务、Registry、Root/Publisher key 或 Desktop candidate；
- 没有实际执行 freeze、rollback、rotation、revocation 或 official-installer recovery；
- 没有验证事件存储的访问控制、高可用和重复投递；
- 没有用户、订阅、BYOK、Provider 请求、credits 或费用；
- R1-R6 继续未满足；本演练不能被称为 canary、production candidate 或 release。

P1 只关闭 R6 本地基线的 tabletop 子项，E1/E2 技术演练保留给后续获批阶段。
