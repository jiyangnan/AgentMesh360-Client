# Agent 后台切换、入口真实性与统一下拉修正

状态：源码与自主验证已完成，随下一内部包统一交付

日期：2026-08-02

## 1. owner UAT 暴露的问题

1. Agent 首页仍展示“＋ 添加 Agent”，但当前用户不能完成自助新增，入口承诺与实际能力不符；
2. Agent 模型和 Provider 页面共 7 个下拉仍调用 macOS 原生弹出菜单，与客户端视觉、字号和
   键盘交互不一致；
3. 一个 Agent 初始化或生成时，Renderer 把整个工作区当成全局锁，其他已经常驻的 Agent
   也不能选择，打断正常的多 Agent 工作。

## 2. 本轮范围

1. 从用户 DOM 中移除尚不可兑现的“添加 Agent”入口，但保留 Package Controller、IPC、
   签名校验、更新、回滚和内部自动化合同；
2. 将 Agent 模型页、Provider 配置弹窗和 Provider Probe 的全部 7 个原生下拉升级为同一套
   应用内 Combobox/Listbox；保留既有 FormData、动态模型发现和业务事件合同；
3. 把运行状态收敛到具体 Agent：A 初始化或处理时，B/C 仍可打开和聊天；A 的迟到 push、
   IPC 成功或失败不得覆盖当前 B/C，也不得污染草稿；
4. 先写旧实现必失败的点击级回归，再执行 Renderer、Controller、Provider、Agent 管理、
   Package、产品旅程和视觉测试；
5. 用户在本轮后续明确要求当前工作由主 Agent 独立完成、不调用 Kimi；因此以完整 diff
   审计、正常本机环境回归、负向测试、秘密扫描和执行证据对账替代 Kimi 门禁。该例外只
   适用于用户指定的本轮，不改变未来是否恢复独立交叉测试的产品决定。

## 3. 交互合同

- 下拉触发器使用 `role="combobox"`，菜单使用 `role="listbox"`，选项使用
  `role="option"`；支持鼠标、方向键、Home/End、Enter/Space、Escape、Tab 和点击外部关闭；
- Provider 分组、禁用态、占位符、长模型列表滚动和动态选项必须保持；展开菜单不能被弹窗
  滚动区域裁剪；选择只触发一次既有 `change`；
- 当前正在工作的 Agent 只禁用自己的 Composer 和设置写入，不禁用其他 Agent 卡片或二级栏；
- Agent 切换采用 latest-intent；旧 Agent 的完成结果只清理其自己的 pending 状态，不写入
  当前 Agent 的消息、错误或草稿；
- Package Center 本轮只从公开 UI 隐藏，不删除未来动态 Agent 所需的底层能力。

## 4. 非目标

- 不开放在线 Agent 商店或自助安装；
- 不重写 Provider、模型发现、连接测试或 Agent 激活业务；
- 不新增多会话、自动 fallback、价格/余额、P7/P8、签名、公证或在线发布；
- 测试不发送真实消息、不读取 Provider Key、不请求 Provider、不消耗 credits。

## 5. 完成门槛

- 首页不存在 `#add-agent`，首次进入 Agent 页也不读取 Package snapshot；
- 7 个下拉都只能通过应用内控件操作，展开态、键盘、ARIA、分组、动态模型和 Probe 选择有
  自动化覆盖；
- A 处理中可切换并打开 B，B 可继续发送；A 的迟到状态不能覆盖 B；
- 产品架构、测试用例和进展文档不再把全局 Agent 锁或当前可见“添加 Agent”写成产品合同；
- 加强自主复核无 P0/P1/P2；功能先以独立提交封存，不生成会立即被下一 Composer 切片
  替换的中间包；下一份 arm64 内部包必须同时包含本轮与 Composer，并继续保持 0 消息、
  0 Provider 请求、0 credits。
