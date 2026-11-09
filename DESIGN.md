---
version: alpha
colors:
  surface: "#ffffff"
  ink: "#252c32"
  muted: "#606b75"
  primary: "#3567d6"
  border: "#e3e8eb"
  darkSurface: "#1f1f1f"
typography:
  sans:
    fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: 14px
    lineHeight: 1.7
rounded:
  control: 8px
  sectionSymbol: 12px
spacing:
  field: 16px
  section: 32px
components:
  button:
    rounded: 8px
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
  dialog:
    width: 540px
    textColor: "{colors.ink}"
  hint:
    textColor: "{colors.muted}"
---

# FduNav design context

## Overview

FduNav is a Chinese desktop campus assistant. Settings should feel like a quiet campus service desk: clear destinations, readable instructions, compact actions, and visible permission boundaries. This is a product surface, not a promotional page.

The mailbox feature has one deliberate visual distinction: official webmail and assistant reading appear as two plainly named sections. A full client already exists on the official site; the application should make reaching it easy and make assistant access understandable.

Design source: the existing GeneralPanel, LlmPanel, shared Icon, native dialogs and runtime tokens. The downloaded Anthropic guide is preserved in `docs/design-guides/frontend-design/` with its source and license. Product behavior follows `UX-CONTRACT.md`.

## Colors

`src/renderer/src/styles/tokens.css` is canonical. This document describes those values; it does not generate a second theme. Mail CSS consumes semantic variables only. The frontmatter palette is the light-theme reference: surface → `--color-bg-surface`, ink → `--color-text-primary`, muted → `--color-text-muted`, primary → `--color-accent`, border → `--color-border-subtle`.

The dark surface is #1f1f1f; text is #f0f0f0, muted text #b8b8b8 and accent #d0d0d0. This follows the existing restrained dark theme. Success, warning and error retain semantic token colors. Never communicate connection state with color alone.

## Typography

Use the existing system sans family with Chinese fallbacks. Page title 20px/600, section title 16px/600, body and controls 14px, secondary explanation 12px. Chinese instructions use relaxed line height. Addresses and domains wrap rather than overflow. Do not add a web font or a separate decorative type style for mail.

## Layout

Left-aligned settings column, capped at the existing 48rem content width. Use the established 4px spacing rhythm: 8px within related controls, 16px around fields, 32px between major sections. Divide sections with a thin rule rather than wrapping each item in a card. The envelope symbol identifies the destination without becoming an illustration.

The connection form is a 540px native modal with viewport margins. Advanced server fields stay behind a disclosure. Its action area remains reachable while scrolling. At 480px the padding tightens; action labels remain readable and primary controls retain useful touch targets. The desktop application keeps its existing settings shell; the browser fixture's narrow navigation is a test harness only.

## Elevation & Depth

Static settings content stays flat. Native modal dialogs use the existing calendar-dialog surface and backdrop. No new gradients, nested shadows, floating stat tiles or entrance animations. Browser-native popups own select placement and stacking.

## Shapes

Reuse 8px control corners, 12px section symbol corners and existing dialog geometry. Radius is structural hierarchy, not decoration. Focus rings remain visible in both themes.

## Components

Reuse primary-button, secondary-button, icon-button, llm-switch, Icon, calendar-dialog and ConfirmDialog. MailConnectionDialog composes the existing native modal pattern; it is the business-specific IMAP form, not a new overlay framework. Native selects match sibling settings and preserve platform keyboard behavior. Loading, failure, saved and paused states occupy the same section.

No new motion is introduced; global reduced-motion token overrides remain authoritative. Write action labels in plain Chinese: 打开、测试连接、连接并保存、移除本机连接. Keep web login and assistant authorization explicitly separate.

## Do's and Don'ts

- Keep official mailbox access available when the assistant connection is absent or broken.
- Name the destination and result of each action; show recoverable errors near the workflow.
- Preserve passwords during failed attempts and discard unsaved form edits only after confirmation.
- Avoid repeated bordered cards, ornamental badges and protocol details in primary navigation.
- Do not imply that a mock preview or protocol fixture proves a real account works.

## Reconcile drift

No maintained design document existed at the implementation baseline. This scan records existing tokens and shared controls without rebranding them. Legacy form/audit findings are tracked in `evidence/mail/verification.md`; they are not silently treated as compliant.
