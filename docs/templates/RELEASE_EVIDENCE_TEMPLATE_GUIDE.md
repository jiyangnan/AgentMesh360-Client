# AgentMesh360 Release Evidence 模板说明

状态：P1 本地模板；不是 release、canary 或生产证据

模板目录：
[`release-evidence-v1`](release-evidence-v1)

使用规则：

1. 把目录复制到受访问控制的发布证据位置，不在仓库中保存内部身份或原始 receipt；
2. 保留九个固定文件名，替换 `rel_template`、`REPLACE_ME` 和全零摘要；
   同时保留 00/06/07 号 Markdown 中现有的身份字段标签和反引号格式，每个字段必须且
   只能出现一次；验证器会把它们与 01-05 号 JSON、`events.v1.jsonl` 的
   `releaseId` / `publicVersion` 交叉绑定；
3. `events.v1.jsonl` 只写
   [`RELEASE_EVENT_SCHEMA_V1.md`](../architecture/RELEASE_EVENT_SCHEMA_V1.md)
   允许的事件；
4. JSON 只保存公开标识、版本、摘要、固定结果和非秘密 receipt ID；
   不允许重复 object key，也不能把 URL、路径或秘密藏在 JSON key 中；
5. Markdown 不粘贴日志、命令输出、URL、Header、用户数据或错误原文；
6. 模板默认 `blocked` / `NO_GO`。只有证据实际成立并经过独立复核后才能修改；
7. 进入任何下一状态前运行完整验证：

```bash
node tools/release-evidence/validate-release-evidence.mjs \
  --evidence-dir /path/to/release-evidence
```

验证器通过只证明结构有界且未命中已知敏感内容，不证明签名、发布、canary 或恢复
真实成功。
