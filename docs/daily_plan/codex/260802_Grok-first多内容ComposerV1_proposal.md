# Grok-first 多内容 Composer V1 开发提案

状态：源码、自动化与本机 Electron 验收已完成；等待唯一内部包安装验收
日期：2026-08-02

## 问题

当前客户端虽然基于 Grok Build，但 Desktop 把 `session/prompt` 收窄成单个 Text Block，
导致用户不能从主对话直接提供截图、简历、课件、部署说明或网页链接。输入区因此不像真正
的 Agent 工作入口，也没有体现 Grok Harness 已有的多内容能力。

## 本轮目标

1. 调整产品设计，形成单一、紧凑、普通用户可理解的多内容 Composer；
2. 接通图片、文档、链接的 Desktop → ACP → Grok Host 完整链路；
3. 文件路径和内容不进入 Renderer，暂存与生命周期由 Main 管理；
4. 添加失败、模型失败、成功销毁和切换恢复均有明确行为；
5. 10 个附件时仍通过 13 寸 MacBook Pro 尺寸回归；
6. 更新蓝图、设计规范、结构化测试用例和项目进展。

## 实现切片

- [x] 审计 Grok Build 原生 Prompt Parser、文件处理和能力声明；
- [x] 冻结 V1 用户流程、支持类型、安全限制和非目标；
- [x] 新增 Main 私有附件暂存、类型/大小/账号/Agent 校验；
- [x] 将对话发送改成 ACP `Text` / `Image` / `ResourceLink` / `Resource`；
- [x] Host 声明图片与 Embedded Context 能力；
- [x] 新增“＋”菜单、系统选择、拖放、粘贴、链接、Chip 和删除；
- [x] 成功后销毁，失败时保留文字与附件；
- [x] 新增 Node、ACP、Electron、负向、安全和 13 寸布局回归；
- [ ] 生成并安装验收唯一内部包，删除旧包后提交推送。

## 非目标

- 不增加音频/视频输入；
- 不承诺 DOCX/XLSX 专用富解析；
- 不增加云文件库、附件长期存储或真正多会话；
- 不实现 Prompt Queue、Interjection 或自动 fallback；
- 不进入 P7/P8、Developer ID、公证或在线发布。

## 源码验收结果

- Desktop targeted Node：65/65 passed；
- Desktop 全量 Node：150 passed、5 个显式 real-Host gate skipped、0 failed；
- 产品旅程结构校验：3/3 passed；Agent 管理、Provider、Conversation、紧凑布局与
  Package 五组 Electron smoke 全部通过；
- Electron 对话交互：通过文件、链接、截图粘贴、删除和仅附件发送；
- Electron 1280×768：10 个附件保持 47px 单行，Composer Form bottom 750px；
- Rust `cargo fmt --check`：通过；
- Rust `cargo check`：正常本机环境通过；受限沙箱首次失败仅因 protoc 不能写
  `/dev/stdout`，已用相同命令在正常环境复跑；
- 用户明确要求本轮由主 Agent 独立完成，因此不调用 Kimi，也不记录虚假的 Kimi 结论。

## 下一步

源码与本机窗口回归已经关闭。下一步仅完成内部 release Host、唯一 DMG/ZIP、摘要与安装
验收，然后提交推送。下一产品切片回到既定计划，不扩展为音视频、云存储或消息队列。
