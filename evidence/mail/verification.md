# Mail integration verification — 2026-11-09

## Automated checks

- `npm run test:mail`: 19 passed, zero failures and zero skips, including TypeScript checking of the tests.
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

## Live Fudan boundary

- DNS and TCP/993 connectivity succeeded. TLS certificate validation succeeded without disabling verification.
- Server greeted as Coremail IMAP. Short and full-address login attempts failed with the server's generic authentication error.
- A separate attempt through the production ImapFlow transport, including client ID, also failed authentication. No messages were read or modified.
- The official HTTPS webmail login was attempted through the browser and returned “用户名或密码错误，或登录受到限制”. No password reset, permission changes or repeated login loop was attempted.
- Therefore **real-account listing/body retrieval is not verified**. A working email credential/client password and any required IMAP enablement must be established by the account owner. The exact reason cannot be inferred from generic server errors.
- The official web login page is reachable; authenticated full-webmail and the Electron window's authenticated flow still require a working account. Browser fixture and protocol tests do not replace that check.
- Encryption tests use an injected authenticated cipher. The production adapter reuses the existing Electron OS secure-storage implementation; an actual account save through that adapter remains unverified because authentication fails first.

## Design reconciliation and remaining scope

Runtime tokens and shared controls remain canonical. DESIGN.md records the existing visual language; it does not change the application palette. No custom complete mail client, SMTP feature, Agent write tool, attachment ingestion or automatic reply is introduced.

The temporary checkout lost during a runtime reset was recovered into the durable development checkout. Memory-list UI is saved as its own local commit. Backend and email UI are saved separately. A PR is held for review.
