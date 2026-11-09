# Mail integration verification — 2026-11-09

## Automated checks

- `npm run test:mail`: 21 passed, zero failures and zero skips, including TypeScript checking of the tests. The final two tests cover safe authentication diagnostics and no automatic authentication retries.
- The protocol test uses the actual ImapFlow library against a disposable local TLS IMAP server. Its test certificate is explicitly trusted only by the injected test client; production certificate validation is unchanged.
- Confirmed Chinese encoded subjects and GB18030/base64 bodies decode correctly; commands use EXAMINE and BODY.PEEK, with no SELECT/STORE/APPEND/MOVE/EXPUNGE and no change to Seen flags.
- Service tests cover encrypted configuration, owner isolation, failed replacement, setup cancellation during encryption, read cancellation, disabled access, stale UID references, pagination, empty/unavailable excerpts, bounded tool results, unsafe navigation and exactly two Agent read tools.
- `npm run build`: passed, including main/preload/renderer type checks and production bundles.
- `npx --no-install tsc --noEmit -p tsconfig.mail-ui.json`: passed for the production UI plus browser fixture.
- Supported-minimum Node 22.13.0: the same 19 tests passed with zero skips (`node22-tests.txt`). The test resolver uses the older async registration API to support this version.
- Production dependency audit: zero known vulnerabilities (`dependency-audit.json`).
- Official `designmd lint DESIGN.md`: zero errors, two orphan-token warnings for documented border/dark-surface palette values (`design-lint.json`). Runtime CSS remains canonical.
- Full renderer strict design audit: exit 1, 15 findings. Applying the identical ownership manifest/contracts to upstream `9bd20cb` produces the same 15 findings; zero new findings (`premium-audit-comparison.json`). These concern untouched legacy forms/textareas and two action-detection findings. The whole app is not claimed to pass this check.

## Browser checks using production components and mock MailAPI

Served through `npm run test:ui` at `/tests/mail-ui.html`. The fixture imports the actual MailPanel and MailConnectionDialog. Mock data is labelled in its header and is not bundled into the application.

- Unconnected → connect form → missing-password validation focuses the password input.
- Edited form → Escape → discard confirmation → Cancel preserves draft and restores modal focus.
- Test success → connect/save → configured address and enabled state appear.
- Edit → Escape returns focus to Modify Connection.
- Remove → explicit local-only confirmation → unconnected state, focus returns to Connect.
- Authentication failure retains form and gives actionable IMAP/password guidance.
- Slow test → Stop → stopped feedback; controls become usable again, no settings saved.
- Slow save → Cancel Connection → stopped feedback, draft preserved and no settings saved. Starting either operation places keyboard focus on its cancel control.
- Provider select popup opens with native options. Choosing Other opens advanced fields; invalid host focuses the visible host input.
- Light and dark themes inspected, including 390×844 narrow viewport. Advanced disclosure and sticky actions remain usable.
- Pausing and re-enabling immediately update the labelled switch and connection state. Loading-error recovery remains available alongside official webmail access.
- Preview console check found no warnings/errors in the final loaded page.
- During visual QA, fixed focus loss after successful connection creation/removal, where the original trigger is replaced in the DOM.

Screenshots in this directory use **mock accounts only**. They contain no real mailbox content or credentials.

### Setup guidance follow-up

The unconnected settings page now names both prerequisites. The student-cloud modal shows three visible steps before account entry: enable and save IMAP/SMTP, generate/copy a client-specific password, paste/test/save in FduNav. Official menu paths for generating the password were checked against the Fudan FAQ; the service checkbox path was observed in authenticated official webmail. The student password field has a specific label, paste instruction and missing-value error. Other providers keep their existing generic guidance.

Rechecked the production components in the mock fixture: standard light/dark views, 390×844 scrolling with reachable action buttons, missing-password focus, pending and successful test feedback, switching to Other (student guide disappears), and Escape focus restoration. Screenshots: `connection-guide-light.png`, `connection-guide-dark.png`, `connection-guide-narrow.png`. Existing 21 tests and production build passed; strict UI audit retains the same 15 untouched legacy findings with none in the changed mail components. No additional live login or mail read was needed for this copy/layout change.

## Live Fudan boundary

### Successful student-cloud read smoke after enabling IMAP

On 2026-11-09, the user completed WeChat login to official student webmail. Its “收发信设置” page showed “开启 IMAP/SMTP 服务” unchecked. After explicit action-time approval, enabled only that checkbox and saved; the page confirmed “设置保存成功” and showed the checked state. POP remained off and the server-side collection period remained “最近30天”.

Using the same client-specific password that failed before the setting change, the production `MailService` and `createMailTransport` completed two authenticated sessions: listing three recent messages with three available body excerpts, then reading one text body (174 characters). Four excerpt/body reads compared message flags before and after; all remained identical. Only aggregate verification results were printed, with no mail content, real account identifiers, credentials, or raw protocol replies recorded in this repository.

The smoke configuration was encrypted in ephemeral memory with a disposable key; no credentials were written to disk or the real app database. The production service and transport were exercised with an in-memory storage adapter, not Electron OS secure storage. No model was invoked. Actual desktop connection save, Agent conversation/trace rendering and the authenticated Electron webmail window still need end-to-end verification. Server-side 30-day visibility limits apply even if the Agent requests a longer period.

The earlier failures below are historical; they no longer describe current student-cloud connectivity.

### Student cloud-mail correction

The initial default and live checks below targeted the **old Coremail system**, whereas this user's student mailbox belongs to **m.fudan.edu.cn**. Those failures cannot establish anything about the student-cloud credentials. This was an implementation/configuration mistake.

Corrected the default to `student-number@m.fudan.edu.cn`, IMAP `imap.exmail.qq.com:993` with verified TLS and full-address login, and web entry `https://mail.m.fudan.edu.cn/`. Kept the old system as an explicit alternate preset; existing saved connections are not silently migrated.

Primary evidence: [Fudan cloud service](https://xxb.fudan.edu.cn/fdyyx/list.htm) and [official client settings FAQ](https://xxb.fudan.edu.cn/cjwt/list.htm). The web navigation policy now allows the exact student host and exmail.qq.com, with lookalike rejection covered by tests.

A single production-client connection attempt against the **corrected student-cloud endpoint** reached authentication and returned `NO` with `authenticationFailed: true`. No mail was read or modified and no real credential was saved. The FAQ distinguishes mailbox password from client-specific password when secure login is enabled; the user's actual setting is unknown. Authenticated student webmail is not yet tested. The existing 19 tests, production build and UI-fixture typecheck pass after this correction.

Browser recheck confirms the student provider is selected by default, the advanced server field shows imap.exmail.qq.com/993/TLS, the page displays mail.m.fudan.edu.cn, and Escape restores focus to Connect. `settings-student-cloud.png` records the corrected mock-account page; earlier screenshots preserve the initial old-system default as historical evidence.

### Historical old-system checks

- DNS and TCP/993 connectivity succeeded. TLS certificate validation succeeded without disabling verification.
- Server greeted as Coremail IMAP. Short and full-address login attempts failed with the server's generic authentication error.
- A separate attempt through the production ImapFlow transport, including client ID, also failed authentication. No messages were read or modified.
- The official HTTPS webmail login was attempted through the browser and returned “用户名或密码错误，或登录受到限制”. No password reset, permission changes or repeated login loop was attempted.
- At that stage real-account listing/body retrieval was unverified. These old-system failures do not diagnose the student-cloud account; the successful student-cloud smoke above supersedes that boundary.
- The official web login page is reachable; authenticated full-webmail and the Electron window's authenticated flow still require a working account. Browser fixture and protocol tests do not replace that check.
- Encryption tests use an injected authenticated cipher. The production adapter reuses the existing Electron OS secure-storage implementation; an actual account save through that adapter remains unverified.

## Design reconciliation and remaining scope

Runtime tokens and shared controls remain canonical. DESIGN.md records the existing visual language; it does not change the application palette. No custom complete mail client, SMTP feature, Agent write tool, attachment ingestion or automatic reply is introduced.

The temporary checkout lost during a runtime reset was recovered into the durable development checkout. Memory-list UI is saved as its own local commit. Backend and email UI are saved separately. A PR is held for review.
