# ADR：账户隔离的产品 Agent 与不可变 Session Binding

状态：已接受并实现；实际 Sampling/Turn 写入留待切片 D

日期：2026-07-23

相关文档：

- [`PRODUCT_BLUEPRINT.md`](PRODUCT_BLUEPRINT.md)
- [`PERSISTENT_PRODUCT_AGENTS.md`](PERSISTENT_PRODUCT_AGENTS.md)
- [`CC_SWITCH_PROVIDER_RESEARCH.md`](CC_SWITCH_PROVIDER_RESEARCH.md)
- [`../PROJECT_PROGRESS.md`](../PROJECT_PROGRESS.md)

## 背景

切片 A/B 已把 Provider Profile、Credential 和 Model Assignment 按 AgentMesh360
`account_id` 隔离，但原有产品 Agent Registry 仍只以 `agent_id` 为主键，确定性
Main Session 也只由 `agent_id` 派生。同一操作系统账号若登录不同 AgentMesh360 账号，
可能复用相同的 Job Agent、LectureCast Agent 或 Deploy Agent 对话。这不符合“Agent
记得当前用户”的产品语义，也会破坏 Session Provider Binding 的账户边界。

同时，Binding 如果只保存 `provider_profile_id + route_revision`，Profile 或 Catalog
更新后就无法重建旧路由；如果直接引用当前 Profile，则会发生静默路由漂移。

## 决策

### 1. 产品 Agent 单例按 AgentMesh360 账户定义

产品 Agent 的唯一实例键改为：

```text
(owner_account_id, agent_id)
```

“每个 Agent 只有一个固定 Main Session”指每个 AgentMesh360 账户下的每个产品 Agent
各有一个，而不是整台电脑跨所有账号共享一个。新 Main Session UUID 由
`owner_account_id + agent_id` 共同确定，Workspace 也进入账户子目录。

### 2. 旧单账户状态采用首次有效账号认领

升级前的 Registry 行没有 `owner_account_id`。迁移时保留为 legacy unowned 行，不猜测
账号。升级后第一次通过订阅硬门禁的有效账号可以原子认领这些行，并保留原来的
Main Session ID、Workspace、激活时间和运行状态。之后登录的其他账号创建各自的新实例。

认领前，legacy Session 不允许被加载或浏览。数据库迁移失败时 Host 必须撤销本次准入
并失败关闭，不能在账户归属不明时继续恢复 Agent。

### 3. 账户切换必须清除驻留状态并隐藏其他账号 Session

有效账号发生变化时，Host 清除旧账号产品 Session 的 pin/restore 状态，再恢复新账号
`desired_state = running` 的实例。其他账号的产品 Session 即使仍存在于 Grok Session
Store，也必须从列表和历史中隐藏；直接使用其 Session ID 调用时必须返回账户不匹配。

本地数据不会因退出登录、订阅失效或账号切换而删除。

### 4. SessionProviderBinding 是追加式完整非秘密快照

每个 Session 当前 Binding 由一组追加式 revision 构成。首次绑定 revision 为 1；只有
用户显式切换或兼容迁移才能创建下一 revision。旧 revision 永久保留，不原地更新。

每个 Binding 保存完整、非秘密的 `PreparedRoute` 快照，包括：

- Provider Profile/Preset ID、模型 ID 与显示分类；
- protocol、auth kind、Base URL 与 endpoint origin；
- profile route revision、assignment revision 与 catalog revision；
- capability snapshot、Quirk 白名单与快照哈希；
- Agent、role、Session、binding revision 与时间戳。

Binding 不保存 API Key、Credential Ref、认证 Header 或可执行逻辑。

### 5. Profile/Catalog/Assignment 更新不改写已有 Binding

已绑定 Session 继续读取其快照。编辑 Profile、更新 Catalog 或修改 Assignment 只影响
尚未绑定的 Session，或用户显式创建的新 Binding revision。RouteCompiler 不能在每个
Turn 重新覆盖现有 Binding。

### 6. Profile 删除不级联删除 Binding

删除 Profile 可以删除其当前 Assignment 与 Vault 凭据，但不能删除 Session Binding
和对话历史。此时历史仍可见，执行因无法解析当前凭据而失败关闭，用户可以重新配置
原 Provider 或创建明确的迁移 revision。

### 7. Turn 路由记录引用实际 Binding revision

每个实际推理 Turn 记录 Session ID、binding revision、Provider/模型/协议、能力快照哈希
和时间戳，不记录秘密。切片 C 先建立存储接口；切片 D 在真正提交 Sampling 请求时写入，
避免把“计划路由”误记成“实际调用”。

## 后果

- 修复同机多 AgentMesh360 账号共享产品 Agent 历史的风险；
- Session 可以稳定复现原路由语义，Profile/Catalog 更新不会静默漂移；
- 旧本地状态能够在不删除 Session 的前提下迁移；
- Profile 删除后可能出现“历史可见但原路由不可执行”，这是有意的失败关闭状态；
- 切片 D 必须从 Binding 快照构造 Sampling 路由，并在发送请求时记录 Turn 路由。
