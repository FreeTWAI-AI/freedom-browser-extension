# Freedom Browser Extension

Side-panel UI for pairing a browser to 自由工坊. Dense, quiet, and keyboard-first. No marketing page, no remote assets.

## 1. Visual Theme & Atmosphere

A narrow tool column, not a dashboard. Paper background, pine accent, ink text. Light and dark follow `prefers-color-scheme`. Status is a sentence, then one next action. Nothing animates for decoration. The extension does not use illustration, emoji, or a second brand color.

## 2. Color Palette & Roles

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--bg` | `#f6f3ec` | `#1c1916` | page background |
| `--ink` | `#1e1a16` | `#f3efe7` | primary text |
| `--muted` | `#5c564e` | `#c8bfb2` | secondary text |
| `--line` | `#ddd4c6` | `#3a342c` | borders and secondary buttons |
| `--accent` | `#0c6b52` | `#1f8a6d` | primary button fill and focus |
| `--accent-ink` | `#f6f3ec` | `#f6f3ec` | text on the primary button |
| `--danger` | `#8d3b2f` | `#e0a598` | revoked / expired text, with the phase sentence |
| `--code-bg` | `#efeae1` | `#2a251f` | user-code plate |

Do not add hex values in components. `color-scheme: light dark` is set on `:root`.

## 3. Typography Rules

Stack: `"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", ui-sans-serif, sans-serif`. Installed system fonts only. No remote font files.

| Role | Size | Weight | Line height |
| --- | --- | --- | --- |
| Panel title | 20px | 650 | 1.4 |
| Section title | 16px | 650 | 1.4 |
| Body | 15px | 400 | 1.55 |
| User code | 20px | 650 | 1.4, `ui-monospace` |

No letter-spacing. Traditional Chinese copy stays short. Inputs, if added later, stay at least 16px.

## 4. Component Stylings

- Primary: one per view, full width of the column, height at least 44px, accent fill, accent-ink text. Labels: 連接, 開啟確認頁, 重新連接, 授權這個網站.
- Secondary: transparent fill, `--line` border, height at least 44px, width of the label. 中斷連線 and 移除 use this.
- Focus: `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible` only.
- Disabled: opacity 0.6, still visible.
- User code: `--code-bg` plate, selectable text, not a link.
- No cards, no icon buttons, no inputs in this version.

## 5. Layout Principles

Spacing scale: 4, 8, 12, 16, 24. The column is `width: 100%`, `max-width: 22rem`, padding 16px, left aligned. Related lines use 8px; sections use 24px. Radius is 6px on buttons and the code plate. No nested cards.

## 6. Depth & Elevation

No shadows. Separation is whitespace and `--line`. The side panel sits on the browser chrome; the page does not float a modal.

## 7. Do's and Don'ts

- Do say 未連接, 等待你在自由工坊確認, 已連接, 已撤銷, 已過期, 需要重新連接.
- Do keep one primary action.
- Do not use emoji, gradients, hero type, or a centered marketing card.
- Do not show tokens, device codes, or provider keys.
- Do not open the verification URI from a URL typed in the page. The button asks the service worker to open the stored URI.

## 8. Responsive Behavior

The column already fits a side panel. At 360px it is full width. At 1280px and 1440px it stays 22rem on the left; it does not grow into a wide dashboard. There is no sidebar to collapse. No horizontal scroll.

## 9. Agent Prompt Guide

Reuse the tokens above. Example: "Add a secondary button labeled 移除 under the site row, 44px tall, `--line` border, left aligned, no new color."
