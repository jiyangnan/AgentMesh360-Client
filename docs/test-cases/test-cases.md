# AgentMesh360 Client 产品用户旅程测试用例

版本：1.0
更新时间：2026-07-31
产品依据：`docs/architecture/PRODUCT_BLUEPRINT.md`
执行原则：文档中的“设计状态”和“本轮结果”分开；没有真实执行证据不得写成通过。

## 1. 测试对象与用户角色

AgentMesh360 Client 是订阅硬门禁下的 BYOK 持久 Agent 客户端。用户登录后配置自己的
模型 Provider，激活 Job Agent、LectureCast Agent、Deploy Agent 或以后动态加入的
Agent，并持续恢复同一个 Main Session、工作区、计划、活动和产物。Electron 是显示与
交互层，AgentMesh360 Host 是账户、Agent、Provider、Package 和 Session authority，
Grok Build Harness 负责推理循环、工具、权限、压缩与恢复。

主要角色：

- **首次用户**：刚安装客户端，需要完成登录、订阅验证、Provider 配置和首个 Agent 激活；
- **持续使用者**：反复切屏、退出 UI、重启电脑并继续同一项工作；
- **多 Agent 用户**：在 Job、LectureCast、Deploy 之间切换，但不希望每个 Agent 复制一套
  完整 Host；
- **BYOK 用户**：持有 OpenAI、xAI、Anthropic、Gemini、DeepSeek、GLM 或 Kimi Key；
- **Package 使用者**：安装或更新新的签名 Agent，同时要求旧版本可恢复；
- **受限用户**：未登录、订阅失效、网络暂不可用、Key 无权限或 Package 不可信。

## 2. 状态与结果定义

| 字段 | 可选值 | 含义 |
| --- | --- | --- |
| 优先级 | P0 / P1 / P2 | P0 阻断核心使用；P1 重要恢复/安全；P2 增强体验 |
| 设计状态 | 已实现 / 部分实现 / 计划中 / 发布门关闭 | 当前产品事实，不代表本轮测试结果 |
| 验证层 | Rust / Node / Electron / 安装包 / 人工 / 外部真实服务 | 一条用例可以有多层 |
| 本轮结果 | 待执行 / 通过 / 失败 / 阻断 / 不适用 | 只在实际执行后填写 |

## 3. 核心旅程总览

| 旅程 | 用户目标 | 核心用例 |
| --- | --- | --- |
| 安装和启动 | 安装内部版并稳定打开 | TC-INSTALL-001 ～ 003 |
| 登录和订阅 | 用真实账号进入，失效时正确拦截 | TC-AUTH-001 ～ 004、TC-ACCESS-001 ～ 004 |
| 持久 Agent | 激活后长期找到同一个 Agent | TC-AGENT-001 ～ 004 |
| 对话和工作区 | 对话、切屏、恢复、审批和产物不断档 | TC-CONV-001 ～ 007 |
| BYOK Provider | Key → 模型 → 测试 → 保存 → 分配 | TC-PROVIDER-001 ～ 010 |
| Agent Package | 安全发现、安装、更新与回滚 | TC-PACKAGE-001 ～ 005 |
| 后台 Host 和设置 | UI 关闭仍工作，故障后恢复 | TC-HOST-001 ～ 005 |
| 发布与本地交付 | 只保留一个可复核内部包 | TC-RELEASE-001 ～ 003 |

## 4. 安装和启动

## TC-INSTALL-001：unsigned internal 首次安装与打开

- **用户故事**：作为内部测试用户，我希望没有 Apple Developer Program 也能按清晰说明
  打开客户端，同时知道它不是正式签名发行版。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：全新临时安装目录；当前 arm64 DMG；无 Developer ID 与公证。
- **输入**：挂载 DMG，将 `AgentMesh360.app` 拖入目标目录并首次打开。
- **交互步骤**：双击应用；若 macOS 拦截，只对该应用使用“仍要打开”，不全局关闭 Gatekeeper。
- **预期输出**：应用打开登录页或安全工作区；系统提示与内部说明一致；没有伪造签名/公证成功。
- **失败与恢复**：损坏 DMG、摘要不一致或应用缺文件时停止，不启动 Host。
- **验证层**：安装包 + 人工
- **本轮结果**：待执行

## TC-INSTALL-002：重复打开与单实例聚焦

- **用户故事**：作为用户，我重复点击应用时只想回到现有窗口，不想出现两个互相争抢状态的客户端。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：应用已启动且窗口可隐藏或最小化。
- **输入**：再次双击应用或从 Finder/Dock 打开。
- **交互步骤**：观察进程与窗口；关闭窗口后再次打开。
- **预期输出**：聚焦或重建同一客户端窗口；不生成第二个产品 Host/Leader；登录和草稿状态不被重置。
- **失败与恢复**：第二实例只负责请求现有主进程开窗后退出。
- **验证层**：Node + Electron + 人工
- **本轮结果**：待执行

## TC-INSTALL-003：新包接管旧持久 Host 且数据不丢失

- **用户故事**：作为持续使用者，我安装新内部包后希望真正使用新代码，同时保留账号、Agent 和会话。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：旧包 Leader 正在运行；已有账号、Agent、Provider 和 Session 状态。
- **输入**：安装 Host runtime SemVer 严格更高的新包。
- **交互步骤**：退出旧 UI但保留 Leader；启动新客户端；读取 Host 版本、Catalog 和历史状态。
- **预期输出**：旧 Leader 让位，新 Leader 接管；旧客户端不能反向降级；用户数据、Keychain 和 Main Session 保留。
- **失败与恢复**：新 Leader 启动失败时不得删除旧状态；显示可行动的本机 Host 故障。
- **验证层**：Rust + Node + 安装包 + 人工
- **本轮结果**：待执行

## 5. 登录、账户和订阅

## TC-AUTH-001：Google 系统浏览器 OAuth 登录

- **用户故事**：作为通过 Gmail 注册的用户，我希望点击 Google 登录即可进入，不被要求提供不存在的邮箱密码。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：Core OAuth 已配置；浏览器可访问；账号订阅有效。
- **输入**：点击“使用 Google 登录”，在系统浏览器完成授权。
- **交互步骤**：客户端发起 loopback + S256 PKCE；浏览器完成一次性交接；返回客户端。
- **预期输出**：客户端只接收一次性结果；Access Token 不进入 URL/Renderer；Core 与 Host 双 active 后进入首页。
- **失败与恢复**：取消、state/PKCE 不匹配、回调超时均返回登录页，可重新发起且不残留半登录状态。
- **验证层**：Node + Electron + 外部真实服务
- **本轮结果**：待执行

## TC-AUTH-002：GitHub 系统浏览器 OAuth 登录

- **用户故事**：作为 GitHub 登录用户，我希望获得与 Google 相同的安全和恢复体验。
- **优先级**：P1
- **设计状态**：已实现
- **前置条件**：GitHub OAuth 可用且账号已绑定订阅。
- **输入**：点击“使用 GitHub 登录”并授权。
- **交互步骤**：完成系统浏览器 OAuth；回到客户端；重新启动客户端。
- **预期输出**：首次登录与加密恢复均成功；身份投影只显示当前账号的公开字段。
- **失败与恢复**：OAuth 被拒、绑定冲突或订阅无效时不给工作区权限。
- **验证层**：Node + Electron + 外部真实服务
- **本轮结果**：待执行

## TC-AUTH-003：加密 Refresh Token 恢复

- **用户故事**：作为已登录用户，我重启客户端或电脑后不想重复登录。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：系统安全存储中有当前账号 Refresh Token。
- **输入**：完全退出 Electron 后重启；或隐藏窗口后恢复。
- **交互步骤**：主进程读取加密凭据并轮换 Token；Renderer 只等待公开 bootstrap。
- **预期输出**：无登录闪烁地恢复同一账号；Token 不出现在日志、DOM、SQLite 或命令行。
- **失败与恢复**：凭据损坏/撤销时清理当前认证状态并回登录页，不泄露错误正文。
- **验证层**：Node + Electron + 人工
- **本轮结果**：待执行

## TC-AUTH-004：注销、换账号与本地状态隔离

- **用户故事**：作为共享电脑用户，我注销后不希望下一个账号看到我的 Agent、Provider 或会话。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：账号 A 有激活 Agent、Provider Profile 和 Session；账号 B 可登录。
- **输入**：A 注销；B 登录；再切回 A。
- **交互步骤**：检查首页、会话、Package、Provider 和工作区投影。
- **预期输出**：B 看不到 A 的任何账户级状态；A 再登录时恢复 A 自己的状态；秘密无跨账号读取 API。
- **失败与恢复**：账户 identity 不一致时 Host 失败关闭，不“临时显示旧数据”。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-ACCESS-001：有效订阅进入客户端

- **用户故事**：作为付费用户，我希望登录后快速进入首页，并看见当前订阅周期和 credits。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：Core 与 Host 返回同一账号的有效订阅。
- **输入**：登录或从加密凭据恢复。
- **交互步骤**：等待一次启动 bootstrap；进入 Agent 首页。
- **预期输出**：只在双重验证通过后显示工作区；订阅周期与 credits 是服务端投影，不由客户端自行拼算。
- **失败与恢复**：Core/Host 结论不一致时不进入工作区。
- **验证层**：Rust + Node + Electron + 外部真实服务
- **本轮结果**：待执行

## TC-ACCESS-002：无效、过期或暂停订阅硬拦截

- **用户故事**：作为订阅无效用户，我需要明确知道原因和续订入口，而不是进入一个半可用客户端。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：未订阅、已过期或暂停的账号 fixture。
- **输入**：登录、唤醒、聚焦或定时复验。
- **交互步骤**：观察拦截页；点击去订阅；订阅恢复后重新验证。
- **预期输出**：不能进入任何 Agent/Provider/Package/会话界面；可打开官网订阅；恢复后由新 bootstrap 放行。
- **失败与恢复**：credits 为 0 不能替代订阅结论；客户端不自行绕过服务端。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-ACCESS-003：后台复验不打断正在进行的工作

- **用户故事**：作为正常切屏和查资料的用户，我不希望回到客户端时看到全屏转圈或丢失已填内容。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：有效订阅；Provider 表单或对话草稿填写一半。
- **输入**：切换到其他应用、隐藏窗口、等待聚焦/五分钟后台复验，再切回。
- **交互步骤**：在复验进行时继续输入或保持未保存表单。
- **预期输出**：当前界面保持可见可编辑；无全屏 loading；Provider Key、模型、名称和对话草稿不清空。
- **失败与恢复**：只有新结果明确失效后才切拦截页；认证刷新竞态不向页面冒充 `Authentication required`。
- **验证层**：Node + Electron + 人工
- **本轮结果**：待执行

## TC-ACCESS-004：临时网络错误与旧授权有效期

- **用户故事**：作为网络偶尔抖动的用户，我希望短暂失败不立刻中断，但授权真的过期时必须安全关闭。
- **优先级**：P1
- **设计状态**：已实现
- **前置条件**：存在尚未过期的上次有效授权。
- **输入**：模拟 Core 超时、Host 暂不可用、授权过期三种情况。
- **交互步骤**：执行普通读取、Provider 页面加载和 Agent Prompt。
- **预期输出**：旧授权未过期时可等待新结果；明确失败或过期后所有敏感入口失败关闭；错误为用户可理解文案。
- **失败与恢复**：网络恢复并重新 bootstrap 后恢复，不要求删除本地工作区。
- **验证层**：Rust + Node
- **本轮结果**：待执行

## 6. 持久 Agent

## TC-AGENT-001：Agent 列表、状态和首次激活

- **用户故事**：作为首次用户，我希望看见可用 Agent，知道哪些已常驻，并一键激活所需 Agent。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：有效订阅；Host Catalog 包含 Job、LectureCast、Deploy。
- **输入**：点击未激活 Agent 的“激活并打开”。
- **交互步骤**：Host 绑定当前账户、创建确定性 Main Session 和 Workspace；UI 打开对话。
- **预期输出**：Agent 变为常驻；只创建一个账户级产品实例和固定 Main Session；重复点击打开同一个 Session。
- **失败与恢复**：激活失败不留下半激活 Registry；错误可重试。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-AGENT-002：关闭窗口、重启后恢复同一 Agent

- **用户故事**：作为持续用户，我希望 Agent 激活后一直存在，随时找到原对话。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：Agent 已激活并有多轮历史。
- **输入**：关闭窗口、退出 Electron、重启客户端。
- **交互步骤**：从首页点击“打开对话”；检查 Session ID、历史、Workspace。
- **预期输出**：恢复确定性同一 Main Session；历史、状态与产物连续；不创建“看起来同名”的新会话。
- **失败与恢复**：Session 缺失时按 Host 恢复合同重建并给出明确恢复状态，不能静默换身份。
- **验证层**：Rust + Node + Electron + 人工
- **本轮结果**：待执行

## TC-AGENT-003：多 Agent 切换但共享一个 Host

- **用户故事**：作为多 Agent 用户，我希望 Job、LectureCast、Deploy 各有自己的长期窗口，但不会启动多份完整 Harness 撑爆内存。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：至少两个 Agent 已激活。
- **输入**：在多个 Agent 之间连续切换、分别发送消息。
- **交互步骤**：观察 Session、Workspace、Leader/PID 和各自历史。
- **预期输出**：每个 Agent 只有自己的固定 Main Session；共享同一个 Host/Leader 与 Harness 基础设施；上下文不串线。
- **失败与恢复**：一个 Agent Turn 失败不重启或清空其他 Agent。
- **验证层**：Rust + Node + Electron + 人工
- **本轮结果**：待执行

## TC-AGENT-004：未来 Agent 的动态双渠道集成

- **用户故事**：作为产品维护者，我希望新 Agent 同一来源既能导出宿主 Skill，又能进入客户端成为持久 Agent。
- **优先级**：P1
- **设计状态**：部分实现
- **前置条件**：新 Agent Manifest、Skill 和权限声明；测试 Root/Publisher 或离线 fixture。
- **输入**：同一来源执行 Artifact、Host Skill plan、Release Manifest 构建与客户端安装。
- **交互步骤**：复验摘要/签名/权限；在 Package Center 安装；激活 Main Session；导出宿主 Skill。
- **预期输出**：两个渠道身份、版本、能力和来源一致；无需改客户端硬编码；客户端得到持久 Main Session。
- **失败与恢复**：任何跨渠道摘要/版本/权限不一致时拒绝；当前生产 Trust/Registry 关闭。
- **验证层**：Rust + Node
- **本轮结果**：待执行

## 7. 对话、权限与工作区

## TC-CONV-001：发送消息、流式响应与持久化

- **用户故事**：作为用户，我输入任务后希望及时看到响应，并在完成后保留完整历史。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：Agent 已激活；有效 Provider Assignment；订阅有效。
- **输入**：一条普通文本消息。
- **交互步骤**：发送；观察排队、运行、流式文本和完成状态。
- **预期输出**：消息只进入当前 Main Session；Turn 使用冻结的 Provider route；响应可见且重开后仍存在。
- **失败与恢复**：超时/限流/认证失败不伪造成功，不自动跨 Provider fallback。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-CONV-002：切换页面、退出 UI 与恢复

- **用户故事**：作为用户，我处理中途查看 Provider 或 Package 页面后返回时不想丢进度。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：当前 Session 有历史或正在运行的 Turn。
- **输入**：切换侧栏、最小化、关闭窗口、重新打开。
- **交互步骤**：回到“当前对话”；查看活动、计划和输出。
- **预期输出**：Session 不变；运行中状态由 Host 对账；完成结果恢复；Renderer 不持有 authority 状态。
- **失败与恢复**：通知丢失时以 Host snapshot 修正，不重复提交 Turn。
- **验证层**：Node + Electron + 人工
- **本轮结果**：待执行

## TC-CONV-003：未发送草稿和配置草稿不丢失

- **用户故事**：作为用户，我切屏或临时离开后希望继续填写一半的信息。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：对话输入框或 Provider 表单有未提交内容。
- **输入**：聚焦变化、后台订阅复验、侧栏切换。
- **交互步骤**：输入唯一草稿标记；触发上述事件；返回原页面。
- **预期输出**：草稿逐字保留；页面不被无条件重建；保存/测试状态只在相关字段变化时失效。
- **失败与恢复**：注销、明确账户切换或成功保存可以清空相应敏感草稿。
- **验证层**：Node + Electron + 人工
- **本轮结果**：待执行

## TC-CONV-004：标准 ACP 单次权限审批

- **用户故事**：作为用户，我希望 Agent 需要敏感操作时先说明并让我选择一次，而不是自行批准。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：测试 Session 触发 `session/request_permission`。
- **输入**：允许一次、拒绝、关闭窗口、过期选择四种交互。
- **交互步骤**：查看动作摘要和选项；选择；观察 Host 继续或停止。
- **预期输出**：只接受当前 Request 的可见一次性选项；永久/未知/旧 Renderer 选择失败关闭。
- **失败与恢复**：权限请求失联或 authority 改变时自动取消，不把操作当成功。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-CONV-005：工具活动的安全投影

- **用户故事**：作为用户，我想知道 Agent 正在读写或执行什么类别的工作，但界面不应泄露秘密、完整命令或私有路径。
- **优先级**：P1
- **设计状态**：已实现
- **前置条件**：当前 Main Session 产生工具调用。
- **输入**：开始、更新、完成、失败工具活动 fixture。
- **交互步骤**：观察活动卡片和重启后对账。
- **预期输出**：只显示固定安全标题、类别和四态；原始命令、cwd、输入输出、Token、路径不进入 Renderer。
- **失败与恢复**：未知工具或 malformed 投影被隐藏/失败关闭，不直出原文。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-CONV-006：产物、项目状态与 Session Plan

- **用户故事**：作为用户，我希望知道 Agent 生成了什么、项目做到哪一步、下一步是什么。
- **优先级**：P1
- **设计状态**：已实现
- **前置条件**：Workspace Manifest、Project State、canonical TodoState fixture。
- **输入**：有效、缺失、越界、篡改和跨账号资源。
- **交互步骤**：打开当前对话的产物、业务进度和模型计划区域。
- **预期输出**：只显示 Host 逐次验证的 ID、标题、类别、大小、四态步骤；模型计划与业务进度明确区分。
- **失败与恢复**：路径/文件内容/跨账号/未知状态不投影；读取失败不影响对话历史。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-CONV-007：Provider 失败时无静默 fallback

- **用户故事**：作为 BYOK 用户，我需要知道本次任务到底用了哪个模型；失败时不能偷偷换模型或消耗另一家额度。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：Session 已冻结 Provider Binding。
- **输入**：401、403、404、429、5xx、超时、空响应。
- **交互步骤**：发送 Turn；读取用户错误与 Turn Route 审计。
- **预期输出**：使用同一冻结 route；错误按类型显示；无跨 Provider/模型自动 fallback；无伪造完成消息。
- **失败与恢复**：用户修复 Key/Profile 后显式迁移或新 Session，旧 Session 不静默漂移。
- **验证层**：Rust + Node
- **本轮结果**：待执行

## 8. BYOK Provider

## TC-PROVIDER-001：十个官方 Provider 入口与自动配置

- **用户故事**：作为普通用户，我只想选择供应商，不想理解协议、Header 和 Base URL。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：Catalog revision 3。
- **输入**：打开 Provider 下拉菜单。
- **交互步骤**：逐项选择 OpenAI、xAI、Anthropic、Gemini、DeepSeek、GLM API、
  GLM Coding Plan、Kimi 国际、Kimi 中国、Kimi Coding Plan。
- **预期输出**：十个入口完整；官方协议、认证和地址自动锁定；技术信息默认折叠；自定义端点独立存在。
- **失败与恢复**：Catalog 失败使用受信内置/LKG，不显示半截供应商。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-PROVIDER-002：Key 验证与动态模型发现

- **用户故事**：作为 BYOK 用户，我希望填 Key 后看到这个账号真正可用的模型，而不是固定示例。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：官方 Provider 与真实/fixture Key。
- **输入**：一次性 API Key。
- **交互步骤**：点击“验证 Key 并获取模型”；等待；选择一个模型。
- **预期输出**：Host 只请求官方模型目录；成功显示当前 Key 返回的模型；不执行推理、不产生 AgentMesh credits。
- **失败与恢复**：模型列表为空、非法或超限时失败关闭；Key 不写 Vault/Profile/Probe history。
- **验证层**：Rust + Node + Electron + 外部真实服务
- **本轮结果**：待执行

## TC-PROVIDER-003：模型发现错误分类

- **用户故事**：作为用户，我希望知道是 Key、权限、限流、网络还是服务问题，并知道该怎么改。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：401/403、404、429、5xx、超时、非法 JSON、空模型 fixture。
- **输入**：分别触发上述响应。
- **交互步骤**：执行模型发现；观察状态卡和按钮。
- **预期输出**：稳定中文错误与行动建议；模型选择/测试/保存禁用；无 IPC、HostRequestError、Header 或原始正文。
- **失败与恢复**：修改 Key 后旧失败状态失效，可重新验证。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-PROVIDER-004：GLM Coding Plan 模型发现与 glm-5.2 连接

- **用户故事**：作为 GLM Coding Plan 用户，我希望专属 Key 能读取模型，选择 `glm-5.2` 后真实连接可以正确通过。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：GLM Coding Plan 专属 Key；官方 Coding endpoint。
- **输入**：Key、动态返回的 8 个模型、选择 `glm-5.2`。
- **交互步骤**：验证 Key → 选择 `glm-5.2` → 确认可能产生极小费用 → 测试连接。
- **预期输出**：目录成功不冒充推理成功；连接测试对 Catalog 验证的 GLM 5.2 使用
  `reasoning_effort=none`，返回可见 `content` 后通过并解锁保存。
- **失败与恢复**：只有 reasoning/空内容仍判失败；普通 GLM Key 与 Coding Plan Key 混用时给认证/权限错误。
- **验证层**：Rust + Node + Electron + 外部真实服务
- **本轮结果**：待执行

## TC-PROVIDER-005：Kimi Coding Plan Standard/HighSpeed 权限

- **用户故事**：作为 Kimi Coding Plan 用户，我希望只选择账号有权使用的模型，并区分普通 Kimi API。
- **优先级**：P1
- **设计状态**：已实现
- **前置条件**：Kimi Coding Plan Key 和不同会员 fixture。
- **输入**：`kimi-for-coding`、`kimi-for-coding-highspeed`。
- **交互步骤**：模型发现；分别测试可见模型。
- **预期输出**：使用专属端点；实际列表以 Key 响应为准；HighSpeed 无权限时为稳定权限错误，不伪造支持。
- **失败与恢复**：普通 Kimi API Key 不静默改走 Coding Plan。
- **验证层**：Rust + Node + Electron + 外部真实服务
- **本轮结果**：待执行

## TC-PROVIDER-006：最小真实连接测试与费用确认

- **用户故事**：作为用户，我希望保存前确认模型真的能回答，并明确知道测试可能产生 Provider 费用。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：模型发现成功且已选择模型。
- **输入**：当前 Key、当前模型、明确费用确认。
- **交互步骤**：点击“测试连接”；确认；等待结果。
- **预期输出**：只调用选择的模型、短提示、无工具、有界输出；可见文本非空才通过；成功后解锁保存。
- **失败与恢复**：未确认不发网络；失败保持保存禁用；结果区分认证、权限、模型、限流、网络、超时、空响应。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-PROVIDER-007：安全保存与 Key 清理

- **用户故事**：作为用户，我连接测试成功后希望保存配置，同时 Key 不再留在页面。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：模型发现和连接测试均通过。
- **输入**：Profile 名称、官方配置、已选模型、一次性 Key。
- **交互步骤**：点击“安全保存”；刷新页面；查看已连接 Provider。
- **预期输出**：Host 先写 Vault 再写 Profile；页面 Key 立即清空；列表只显示末四位/公开配置；无 secret-readback。
- **失败与恢复**：Vault/DB 任一步失败按补偿顺序处理，不显示假成功或遗留无主秘密。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-PROVIDER-008：字段变化使旧验证失效

- **用户故事**：作为用户，我修改 Key、模型或端点后不希望客户端沿用旧的“已通过”结果。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：表单已完成模型发现或连接测试。
- **输入**：修改 Provider、Key、模型、协议、认证或 Base URL 任一字段。
- **交互步骤**：观察状态和按钮；尝试直接保存。
- **预期输出**：相关旧模型/连接结果立即失效；保存禁用；必须重新验证。
- **失败与恢复**：仅修改显示名称不应无故产生 Provider 请求，但保存规则按产品合同处理。
- **验证层**：Node + Electron
- **本轮结果**：待执行

## TC-PROVIDER-009：全局、Agent、Session 模型分配与冻结路由

- **用户故事**：作为多 Agent 用户，我希望不同 Agent 使用不同模型，已有会话不会因后来改设置突然漂移。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：至少一个已保存 Provider Profile。
- **输入**：global、Agent、Session 三层 Assignment。
- **交互步骤**：按层级设置；创建/打开 Session；修改 Profile 或 Assignment；发送 Turn。
- **预期输出**：Session > Agent > global；Session Binding 固定具体 revision；旧 Session 不静默改变；Turn Route 可审计。
- **失败与恢复**：Profile 删除/凭据缺失/模型不启用时失败关闭。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-PROVIDER-010：Provider 安全与边界

- **用户故事**：作为用户，我希望 Key 只在本机 Host 的安全存储和短租约中使用。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：带 sentinel secret 的全链路 fixture。
- **输入**：创建、测试、保存、替换、删除和失败请求。
- **交互步骤**：扫描 DOM、日志、SQLite、Session、Probe history、错误响应和构建证据。
- **预期输出**：完整 Key/Authorization/credential secret 零出现；Renderer 无读回；短租约不可序列化；删除先删 Vault。
- **失败与恢复**：安全 Backend 不可用时失败关闭，不退回明文文件或环境变量。
- **验证层**：Rust + Node + 秘密扫描
- **本轮结果**：待执行

## 9. Agent Package

## TC-PACKAGE-001：关闭态目录与 LKG

- **用户故事**：作为内部用户，我希望生产发布没开时仍能安全看到内置 Agent，不会请求未知 Registry。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：生产 Trust/Registry 常量为空。
- **输入**：启动 Host、刷新 Package Center。
- **交互步骤**：读取本地 Active Catalog 与远端状态。
- **预期输出**：只显示内置/本地可信 Package；远端入口明确关闭；无生产网络副作用。
- **失败与恢复**：新目录失败保留 LKG，不清空现有 Agent。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-PACKAGE-002：权限预览、批准与原子安装

- **用户故事**：作为用户，我安装 Agent 前要先看权限，批准后才改变本地运行时。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：可信签名测试 Package 和当前订阅。
- **输入**：新增权限、相同权限、未知权限 fixture。
- **交互步骤**：查看权限 diff；批准一次；执行安装。
- **预期输出**：未知/永久批准不接受；Artifact、签名、Manifest、权限全部通过后原子切换；同 Host Catalog 立即刷新。
- **失败与恢复**：中断或刷新失败保留旧 Active/LKG；无半安装目录。
- **验证层**：Rust + Node + Electron
- **本轮结果**：待执行

## TC-PACKAGE-003：更新、重启恢复与回滚

- **用户故事**：作为用户，我希望 Agent 更新失败时还能继续使用旧版本。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：已安装 v1，存在合法 v2 和损坏 v2。
- **输入**：成功更新、安装中断、刷新失败、重启、显式回滚。
- **交互步骤**：依次执行并检查 Active、LKG、Registry、Main Session。
- **预期输出**：成功原子切换；失败保留 v1；重启对账一致；回滚后运行时、Catalog 和 Session 身份不乱。
- **失败与恢复**：版本反回滚、跨 Agent 或摘要不一致拒绝。
- **验证层**：Rust + Node
- **本轮结果**：待执行

## TC-PACKAGE-004：签名、Trust、Registry 与 Release 失败矩阵

- **用户故事**：作为用户，我希望下载到的 Agent 可证明来源、版本和内容，不能被替换或降级。
- **优先级**：P0
- **设计状态**：部分实现
- **前置条件**：测试 Root/Publisher、可信时间、Registry/Release/Artifact fixtures。
- **输入**：坏签名、过期、吊销、revision 回滚、摘要替换、redirect、超限、跨版本。
- **交互步骤**：发现、下载、复验、安装。
- **预期输出**：任何一层失败都在消费前停止；只拒绝新更新并保留 LKG；无原始 secret。
- **失败与恢复**：生产 Root/Publisher/endpoint 仍关闭，不把 E0/E1 演练写成生产通过。
- **验证层**：Rust + Node
- **本轮结果**：待执行

## TC-PACKAGE-005：Agent Skill 双渠道一致性

- **用户故事**：作为既用客户端又用宿主 Agent 的用户，我希望同一 Agent Skill 能力和版本一致。
- **优先级**：P1
- **设计状态**：已实现
- **前置条件**：同一 Manifest/Skill 来源。
- **输入**：客户端 Artifact、Host Skill plan、Release Manifest。
- **交互步骤**：双构建；复验摘要；比较版本、权限、入口和适用 Host。
- **预期输出**：可复现且跨渠道一致；任何重复/缺失/未知 Host 或 Adapter 都拒绝。
- **失败与恢复**：客户端安装失败不影响宿主 Skill 已有安装，反之亦然。
- **验证层**：Rust
- **本轮结果**：待执行

## 10. 后台 Host 与设置

## TC-HOST-001：关闭 UI 后 Agent Host 继续常驻

- **用户故事**：作为用户，我关闭窗口后仍希望 Job/LectureCast/Deploy 可以被再次找到和恢复。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：Agent 已激活；Leader 正常运行。
- **输入**：关闭 Electron 窗口或退出 Renderer。
- **交互步骤**：记录 Leader PID/Session；重新打开客户端。
- **预期输出**：Leader 与 Main Session 未因 UI 生命周期销毁；新窗口重新附着。
- **失败与恢复**：用户显式“退出全部”合同之外，普通关窗不杀持久 Agent。
- **验证层**：Rust + Node + 人工
- **本轮结果**：待执行

## TC-HOST-002：Leader 崩溃与自动恢复

- **用户故事**：作为用户，我希望后台 Host 意外崩溃后自动恢复，而不是丢失会话。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：登录凭据、Agent Registry 和 Main Session 已持久化。
- **输入**：SIGKILL 当前 Leader。
- **交互步骤**：触发客户端/后台重连；观察新 PID、bootstrap 与 Session。
- **预期输出**：新 Leader 启动；Core/Host 双准入；同一 Main Session 与 Workspace 恢复。
- **失败与恢复**：恢复失败显示 Host 状态，不循环启动多份 Leader。
- **验证层**：Rust + Node + 人工
- **本轮结果**：待执行

## TC-HOST-003：系统登录启动开关

- **用户故事**：作为用户，我希望自己决定开机后 Agent 是否在后台恢复。
- **优先级**：P1
- **设计状态**：部分实现
- **前置条件**：客户端设置页；内部 unsigned build。
- **输入**：开启/关闭“登录时启动”。
- **交互步骤**：切换开关；重启后台组件/模拟登录；再次检查。
- **预期输出**：设置持久；关闭时不注册；开启时隐藏启动单一后台主进程。
- **失败与恢复**：unsigned 内部包不把源码级支持冒充签名安装包 Login Item E2E。
- **验证层**：Node + 人工
- **本轮结果**：待执行

## TC-HOST-004：Host 请求排队与认证更新竞态

- **用户故事**：作为用户，我在登录恢复或订阅刷新瞬间打开 Provider/Agent 页面时不应遇到随机认证错误。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：bootstrap 正在进行或旧授权尚未过期。
- **输入**：并发 Provider snapshot、Agent list、Session load 请求。
- **交互步骤**：启动/聚焦同时快速切页面。
- **预期输出**：ACP Client 顺序等待 bootstrap；旧授权在新结果落定前仍有效；无 `Authentication required` 闪烁。
- **失败与恢复**：新结果明确失败时排队请求统一失败关闭。
- **验证层**：Node + Electron
- **本轮结果**：待执行

## TC-HOST-005：资源和秘密边界

- **用户故事**：作为用户，我希望多 Agent 常驻不会线性复制完整 Host，也不会把凭据暴露给 Agent Package。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：三个 Agent 激活；多个 Session 和 Provider。
- **输入**：并发打开 Agent、执行安全 mock Turn、查看进程/日志。
- **交互步骤**：核对 Leader 数量、Session 分离、Credential Lease 与 Package 权限。
- **预期输出**：单 Host/Leader；按 Agent/Main Session 隔离；Package 只得到声明能力；凭据只由 Host 解析。
- **失败与恢复**：异常 Agent 不获得跨 Agent/跨账号/跨 Provider secret。
- **验证层**：Rust + Node + 人工
- **本轮结果**：待执行

## 11. 内部构建、交付与留存

## TC-RELEASE-001：clean commit 可复现内部构建

- **用户故事**：作为测试者，我希望拿到的 DMG 对应明确 commit，并能复核摘要和 receipt。
- **优先级**：P0
- **设计状态**：已实现
- **前置条件**：clean pushed commit；生产签名 authority 为 none。
- **输入**：arm64 unsigned internal 构建命令。
- **交互步骤**：构建 DMG/ZIP；验证 receipt、SHA-256、DMG 和解包 App。
- **预期输出**：所有摘要和 commit 绑定；DMG/ZIP 内容一致；明确标注内部 unsigned。
- **失败与恢复**：dirty source、版本不一致、摘要或 receipt 错误时阻断。
- **验证层**：Node + 安装包
- **本轮结果**：待执行

## TC-RELEASE-002：始终只保留一个内部测试包

- **用户故事**：作为开发者，我不希望历史 DMG/ZIP/target 持续占满磁盘，也不想拿错旧包。
- **优先级**：P1
- **设计状态**：已实现
- **前置条件**：旧包存在；新包已通过全部门禁。
- **输入**：新构建输出和 Downloads 交付目录。
- **交互步骤**：先验证新包；再删除上一包、旧证据和临时挂载；盘点剩余。
- **预期输出**：Downloads 只有一份当前交付目录；`desktop/dist/internal` 只有一份当前证据；无遗留挂载。
- **失败与恢复**：新包未通过前不得删旧包；清理不碰用户状态、Keychain 或源码。
- **验证层**：Node + 安装包 + 人工盘点
- **本轮结果**：待执行

## TC-RELEASE-003：生产发布门保持关闭

- **用户故事**：作为产品负责人，我希望内部测试不会误触生产上传、自动更新或签名承诺。
- **优先级**：P0
- **设计状态**：发布门关闭
- **前置条件**：无 Apple Developer Program；生产 Root/Publisher/Registry 未授权。
- **输入**：执行内部构建和验收。
- **交互步骤**：检查预检 receipt、配置、网络和产物命名。
- **预期输出**：`authority=none`、`approvalStatus=not_approved`、生产 candidate blocked；不上传、不 tag、不发布更新。
- **失败与恢复**：任何命令试图越过门禁时立即停止并保留审计。
- **验证层**：Node + 安装包
- **本轮结果**：待执行

## 12. 本轮执行记录

本节在代码和测试变更完成后填写。每条记录必须包含日期、commit、实际命令/交互、
通过数量、跳过/阻断原因和非秘密证据位置。外部真实 Provider 推理若可能计费，必须有
本轮明确授权；没有授权时只能记录“阻断”，不得借用旧授权或把 fixture 冒充真实通过。

### 2026-07-31 基线执行

- 执行 commit：功能 commit 待 clean push 后回填；本节先记录工作树验证。
- 自动化结果：
  - AgentMesh360 Rust：197 passed / 1 ignored / 0 failed；
  - GLM 5.2 定向单元与本机 wire：2 passed / 0 failed；
  - Desktop Node：122 passed / 3 个显式 real-Host gate skipped / 0 failed；
  - Repository 工具链：306 passed / 0 failed；
  - `xai-grok-shell --lib` Clippy `-D warnings`、Rust fmt、Desktop syntax、
    `git diff --check` 全部通过。
- Electron 交互结果：Provider、Conversation、Package 三组 smoke 通过。新增
  Provider/Conversation 草稿跨侧栏与状态刷新恢复、跨账号清理、成功保存清理、
  password input value 不进入 HTML markup 等断言。
- 安装包结果：待 clean pushed commit 生成唯一 unsigned internal arm64 包后回填。
- 外部真实服务：GLM Coding Plan 模型发现已由 owner 实际完成；修复后的付费最小推理
  尚无本轮费用授权，不能由开发 Agent 擅自重试。GitHub OAuth 与 Kimi Coding Plan
  也没有本轮外部真实服务凭据/授权，保留为明确阻断。
- 真实桌面操作：当前安装版确认十个 Provider 入口；使用本地假 Key 复现并发现
  Provider/对话草稿在侧栏切换后清空。假 Key 没有点击验证或保存、没有离开本机。
- 已知失败：旧包 `glm-5.2` 空内容误判已在代码和 wire 回归中修复；草稿丢失也已修复。
  两项都必须在新包安装后再次做客户端复验。
- Kimi：按 owner 指示暂停，使用主 Agent 加强自主复核，不冒充独立交叉测试。
