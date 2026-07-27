# Workspace Artifact Manifest v1

状态：Cycle 47 已接受的最小只读契约

## 1. 目标

持久产品 Agent 需要把报告、音频、视频、部署证据等结果保存为可恢复的产品产物，
而不是只把路径写进聊天或依赖 Renderer 读取原始 ToolCall。所有 Agent 使用同一个
Workspace Artifact Manifest；未来 Agent/Skill 只要生成该清单，客户端即可通过通用
界面展示，不需要新增 Agent 专属代码。

本契约只建立“发现和展示”通路，不开放文件、预览、导出、分享、删除或其他 mutation。

## 2. Authority

- Host 根据当前有效订阅、账户和 `agentId` 从 Agent Registry 解析唯一 Workspace；
- Renderer 不能提交 Session ID、Workspace、Manifest 路径或产物路径；
- Manifest 固定为 Workspace 内的 `.agentmesh360/artifacts-v1.json`；
- 产物文件必须位于同一 Workspace 的 `artifacts/` 目录内；
- Host 每次读取都重新验证清单、路径和真实文件，不保存第二份产物数据库；
- Main Session 继续负责对话，Workspace Manifest 负责产物索引，两者不互相复制。

原始 ACP `content`、`locations`、`rawInput` 和 `rawOutput` 只是 Harness 工具遥测，
可能包含命令、路径、秘密或中间结果，不能直接成为产品产物 authority。

## 3. Manifest

```json
{
  "schemaVersion": 1,
  "revision": 3,
  "artifacts": [
    {
      "artifactId": "role-fit-report",
      "title": "岗位匹配报告",
      "kind": "document",
      "relativePath": "artifacts/role-fit-report.pdf"
    }
  ]
}
```

约束：

- UTF-8 JSON，最大 64 KiB，未知字段失败关闭；
- `schemaVersion` 必须是 `1`；
- `revision` 是大于零的安全整数；
- 最多 100 个产物；
- `artifactId` 使用小写字母、数字和连字符，最多 64 字节，不能重复；
- `title` 去除首尾空白后为 1–120 个字符，不能包含控制字符；
- `kind` 只允许 `document/image/audio/video/archive/code/data/other`；
- `relativePath` 最大 512 字节，必须以 `artifacts/` 开头，不能是绝对路径、`.`、
  `..`、平台前缀或重复路径；不同路径也不能指向同一个真实文件；
- Workspace、控制目录、`artifacts/`、中间目录和文件均不能是符号链接；
- 最终目标必须是现存普通文件；目录、设备、Socket 和越界文件全部拒绝。

Manifest 不存在时返回空清单，不视为错误。Manifest 存在但无效时整个清单失败关闭，
不能跳过坏项后展示剩余项。

## 4. Renderer 投影

Renderer 只接收：

```json
{
  "artifactId": "role-fit-report",
  "title": "岗位匹配报告",
  "kind": "document",
  "sizeBytes": 183421
}
```

Renderer 不接收：

- Workspace、相对路径、绝对路径或文件 URL；
- 文件摘要、Manifest 原文、账户 ID、Main Session ID；
- Tool Call ID、工具输入输出、命令或环境变量；
- Host 原始错误或底层文件系统错误。

Renderer 还要再次执行 ID、标题（含 C0/C1 控制字符）、类别、大小和 100 项上限
白名单。索引状态只接受 `ready/unavailable` 语义枚举，用户文案由 Renderer 本地
决定，不接收 Host 错误字符串。无效投影全部丢弃。

## 5. 生命周期

- 打开 Agent 固定 Main Session 后读取一次；
- 每个成功 Prompt 结束后重新读取一次；
- 订阅失效、账户切换、Agent 切换、Leader 重连、Host 退出、关闭对话和 Prompt 超时
  都清空 Renderer 产物投影；
- 清单读取失败不关闭文本对话，只显示固定的“产物索引暂时不可用”状态；
- 不使用文件 watcher，不把目录扫描或 ToolCall replay 当作产物恢复机制。

## 6. 非目标

- 不读取或打开产物内容；
- 不把路径交给 Renderer；
- 不实现预览、导出、分享、删除、版本历史或自动上传；
- 不修改 Agent Package v1，不启动新的生产 Package 切片；
- 不建立第二套 Harness、Session 或产物数据库；
- 不启用生产 Registry、签名、公证或正式桌面发布。
