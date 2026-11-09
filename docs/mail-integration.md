# 邮箱模块

## 使用方式

1. 进入侧栏“邮箱”或设置中的“邮箱”。
2. 日常收发使用“在浏览器打开”或“在应用内打开”。两者均打开复旦官方网页版；应用内会话独立，需要另行登录。
3. 需要助手读取时，选择“连接助手读取”，填写完整邮箱地址和邮箱密码/客户端专用密码。复旦邮箱默认 `mail.fudan.edu.cn`、993、TLS。
4. “测试连接”只验证连接和收件箱访问；“连接并保存”验证后通过系统安全存储加密保存。网页登录状态不能代替 IMAP 授权。
5. 可以暂停助手读取或移除本机连接。移除不删除服务器邮件，也不清除已有对话/执行记录中的邮件片段。

服务商提供的客户端专用密码与网页登录密码可能不同。认证失败时先在官方邮箱核查账号、密码和 IMAP 服务；应用不自动更改邮箱安全设置。系统安全存储不可用时拒绝保存，不降级到明文。

## Agent 工具

仅提供 `list_emails` 与 `get_email`。不提供发送、回复、标记已读、移动、删除或下载附件工具。

`list_emails({days: 30, limit: 5})` 默认按最近收件顺序返回收件箱标题、发件人、收件时间、已读状态和正文摘录。也可传 `from`/`to`（YYYY-MM-DD，含结束日，最多 365 天）。继续分页只传 `cursor` 和可选 `limit`。摘录是有长度限制的正文，不是另一次模型总结；缺失/无法读取的摘录有明确状态。

`get_email({id, offset: 0, limit: 6000})` 使用列表返回的 ID，按需读取文本正文。继续读取使用 `nextOffset`。HTML 转为纯文本，不加载远程图片、不下载附件，中文主题和常见中文编码由 IMAP 库解码。大邮件有正文截断说明。

示例请求：“帮我看最近一周的邮件，找到考试相关通知，再读一下正文。”工具结果经过现有对话和轨迹流程，可以在执行记录中检查。邮件是外部不可信资料，不能授权操作或改变系统指令。

## 实现边界

- `src/main/mail-service.ts`：按校园账号隔离配置、加密保存、权限开关、取消、超时、结果分页和大小预算。
- `src/main/mail-imap.ts`：真实 ImapFlow 客户端，只读 EXAMINE 与 BODY.PEEK，验证 TLS/STARTTLS 证书，关闭原始协议日志。
- `src/main/mail-web.ts`：固定官方入口，独立持久会话，沙箱和上下文隔离，无 preload、无应用 IPC 桥；账号变化时关闭窗口。
- `src/shared/mail.ts`：共享输入校验、预设、日期和返回类型。
- `src/renderer/src/MailPanel.tsx` / `MailConnectionDialog.tsx`：入口、状态与连接表单。

连接元数据和密码一起加密存入 `mail_connections`，渲染层只拿到不含密码的公开设置。密码仅在输入/连接过程短暂驻留内存。读取的邮件片段会发送至用户配置的模型，并进入现有对话与轨迹存储；移除连接不能撤回这些既有内容。

完整邮箱能力由官方网站承担；应用没有重新实现一个邮件客户端。复旦云邮箱、QQ 及自定义 IMAP 预设可配置，但未以真实账号验收。应用内官方邮箱的已登录流程也仍需真实账号验证。

## 验证

```sh
npm ci
npm run test:mail
npm run build
npm run test:ui
```

测试需要项目要求的 Node 版本。协议测试需要 OpenSSL；缺失时会明确跳过。浏览器预览地址为 `http://127.0.0.1:4176/tests/mail-ui.html`，支持 `?connected`、`?authError`、`?slow`、`?loadError`。预览仅使用模拟数据，不访问真实邮箱。

见 `evidence/mail/verification.md`：真实复旦网络和 TLS 连接正常，但提供的凭据被 IMAP 和官方网页拒绝，真实邮件读取尚未验收。不要把本地协议测试等同于真实邮箱连通。

## 资料

- [复旦信息办邮箱说明](https://xxb.fudan.edu.cn/yjzysx_33107/list.htm)
- [ImapFlow API](https://imapflow.com/docs/api/imapflow-client/)
- [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)
- [Anthropic frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design)（下载副本、来源和许可证位于 `docs/design-guides/frontend-design/`）
