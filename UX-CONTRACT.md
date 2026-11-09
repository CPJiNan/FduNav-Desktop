# FduNav interaction contract

Visual decisions live in `DESIGN.md`. This contract records ownership for the touched settings and mailbox workflows. It does not certify untouched screens.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | Native HTML select, as in GeneralPanel and LlmPanel | DESIGN.md and platform interaction | native only for mail provider and encryption | keyboard, open popup, selection, both themes |
| Form | Shared validateMailInput schema and semantic HTML form | src/shared/mail.ts | create and edit connection | first-error focus, aria-invalid, noValidate, test/save/cancel |
| Scrollbar | Global application stylesheet and platform scrollbar | src/renderer/src/styles/base.css | modal viewport geometry in mail.css | narrow viewport, advanced-fields scrolling |
| Toast | Existing inline status/alert convention in settings | GeneralPanel, LlmPanel and native ARIA live regions | local success and error, no new toast provider | visible feedback in browser fixture |
| CRUD | MailService and account-scoped local settings | src/main/mail-service.ts | verified create/replace, pause, local disconnect | tests/mail.test.ts and evidence/mail/verification.md |

## Mailbox navigation and permissions

The official Fudan site owns composing, sending, replies, drafts, folders and attachments. The default browser entry can reuse its own login. The application entry uses a sandboxed account-scoped window with a separate persistent session and no application bridge. Unrecognized navigation is blocked; external HTTPS links opened in a new tab leave the app. Browser fallback remains available.

The Agent owns only `list_emails` and `get_email`. No mail mutation tool exists. IMAP connections always use a read-only inbox and non-marking body fetches. Web login does not enable IMAP. Disconnect removes local assistant credentials; it does not delete mail, clear webmail login, or erase existing chat/trace content.

## Connection form and async behavior

New connections default to Fudan student cloud mail: student-number@m.fudan.edu.cn, imap.exmail.qq.com, TLS/993, with the full email address as login. The official web entry is mail.m.fudan.edu.cn; the old Fudan system remains a separate preset. Users may choose another provider and expand server settings. Validate the same schema in renderer and main process, focus the first invalid field, associate the error through aria-describedby, and use application-owned validation (`noValidate`). Passwords accept paste and password managers. A blank password retains the existing secret only for exactly the same account and endpoint.

The student-cloud connection form always shows an ordered setup guide before the account fields: enable and save IMAP/SMTP in official webmail, generate/copy a client-specific password, then paste/test/save in FduNav. Other providers do not inherit student-specific menu paths. The guide uses flat typography and section rules; it does not change any server settings automatically.

Testing does not save or read bodies. Saving verifies the connection before encrypting the complete configuration using OS secure storage. Failed saves preserve the prior configuration. A stopped setup cannot commit even if cancellation happens during encryption. There is no optimistic “connected” state.

Disable duplicate operations. A slow test offers Stop and a saving connection offers Cancel; operations also have a bounded timeout. Starting an operation focuses its cancel control. Leaving a dirty form asks whether to discard. Native modals own focus trapping and Escape; settings must not close underneath. Closing returns focus to the trigger, including when successful creation/removal changes that trigger. Account changes close the form and invalidate outstanding reads.

Errors are local, actionable and redact raw server messages. Offline/server failures retain the form for retry. The settings-loading error offers retry and reconfiguration. Connection state is written as 未连接、已启用 or 已暂停 in addition to its color.

## Data and inspection

Email titles, senders, excerpts and bodies are untrusted data. They cannot grant tool permission or override system instructions. Read fragments enter the existing tool message and trace pipeline, with the same model-response budgets and inspection surface. Configuration/passwords never enter that pipeline. Excerpts are labelled body excerpts rather than presented as generated summaries; unavailable/empty excerpts have explicit statuses.

List defaults to the last 30 Shanghai calendar days and five messages; dates include the end day. Pagination uses UID boundaries, local connection identity and UIDVALIDITY to avoid reused/stale references. Body pagination reports nextOffset and whether the maximum available body was truncated. Attachments and remote images are not downloaded by Agent tools.

## Locale and accessibility

UI copy is zh-CN; no Japan-market scope is introduced. Dates in settings use zh-CN; tool dates are ISO and the default period is Asia/Shanghai. Reuse global theme and reduced-motion behavior. Semantic labels, keyboard activation, visible focus, native select popup behavior and modal scroll/focus are required in both themes and at narrow width.
