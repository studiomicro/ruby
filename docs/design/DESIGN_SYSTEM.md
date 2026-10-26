# Ruby design system (RB-10, after Kumo)

Owner request of 2026-10-26: "implement design from https://kumo-ui.com/". Kumo is Cloudflare's design system and
React component library (MIT, <https://github.com/cloudflare/kumo>). Ruby is Svelte, so it does not use the Kumo
package or React. Ruby recreates Kumo's visual language in its own tokens (`src/app.css`) and its own Svelte kit
(`src/lib/ui/kit/`). Kumo's token values are ported with attribution (`THIRD_PARTY_NOTICES.md`). Ruby uses no Kumo
component code, no Cloudflare logo and no brand mark. Ruby keeps its own ruby-red mark (`--logo`).

## Principles

- **Calm and dense.** The base text is 14 px (15 px below 768 px). Controls are 36 px, separated by hairline borders
  and light shadows. Neutral greys carry the structure.
- **One blue.** `--brand` fills the primary action (one per view). `--ring` is the keyboard focus ring. `--accent` is
  for links, the current place and counts. Other colours are used only for meaning: danger, success and warning.
- **Light and dark.** Every colour is a token with a light value and a dark value. Dark applies through
  `prefers-color-scheme` unless `<html data-theme="light">` is set, and always when `data-theme="dark"` is set. The two
  dark blocks in `app.css` must stay identical (`test/contrast.test.ts` checks this).
- **AA everywhere.** Text pairs meet 4.5:1. Control boundaries, focus rings and state indicators meet 3:1.
  `test/contrast.test.ts` checks the pairs in both themes.
- **The system layer first.** A feature gets the look from the tokens and the kit, not from its own colours. Feature
  styles use only `var(--token)` values: no hex values and no inline styles (CSP `style-src 'self'`).

## Tokens (`src/app.css`)

Kumo writes its colours in oklch. Ruby stores each one as the sRGB hex value it renders to, so the contrast test can
compute every pair. The table maps each Ruby token to its Kumo source.

| Ruby token         | Light     | Dark      | Kumo source                                   | Use                                        |
| ------------------ | --------- | --------- | --------------------------------------------- | ------------------------------------------ |
| `--bg`             | `#fbfbfb` | `#030303` | `kumo-canvas`                                 | Page background                            |
| `--surface`        | `#ffffff` | `#0f0f0f` | `kumo-base`                                   | Cards, panels, sidebar, dialogs            |
| `--elevated`       | `#f8f8f8` | `#060606` | `kumo-elevated`                               | Table header, code block, row hover        |
| `--surface-2`      | `#f5f5f5` | `#262626` | `kumo-tint`                                   | Hover, current nav item, segmented track   |
| `--surface-3`      | `#e5e5e5` | `#333333` | `kumo-fill`                                   | Neutral badge, stronger hover              |
| `--control`        | `#ffffff` | `#18181b` | `kumo-control`                                | Field and menu background                  |
| `--border`         | `#e6e6e6` | `#333333` | `kumo-line`                                   | Hairlines, card and button borders         |
| `--border-strong`  | `#d4d4d4` | `#404040` | `kumo-interact`                               | Dividers that must show, blockquote rule   |
| `--border-control` | `#8f8f8f` | `#737373` | Ruby (3:1)                                    | Field, checkbox and switch boundary        |
| `--fg`             | `#18181b` | `#f5f5f5` | `text-kumo-default`                           | Body text, checked checkbox fill           |
| `--fg-strong`      | `#0a0a0a` | `#fafafa` | `text-kumo-strong`                            | Headings                                   |
| `--muted`          | `#666666` | `#a1a1a1` | `text-kumo-subtle` (darkened in light mode)   | Secondary text                             |
| `--subtle`         | `#8a8a8a` | `#7a7a7a` | `text-kumo-placeholder` (darkened)            | Placeholders and decoration only           |
| `--accent`         | `#193cb8` | `#51a2ff` | `text-kumo-link`                              | Links, current place, counts               |
| `--accent-soft`    | `#eff6ff` | `#12182b` | `kumo-info-tint`                              | Info banner, accent badge, mention         |
| `--brand`          | `#155dfc` | `#045ede` | `kumo-brand` (blue-600; dark: 10 % black mix) | Primary button, switch on, tab marker      |
| `--brand-hover`    | `#1447e6` | `#1447e6` | `kumo-brand-hover`                            | Primary button hover                       |
| `--danger`         | `#c10007` | `#ff6467` | `text-kumo-danger`                            | Errors, destructive actions                |
| `--success`        | `#006045` | `#a4f4cf` | `text-kumo-success`                           | Confirmations                              |
| `--warning`        | `#9a5700` | `#ff8904` | `text-kumo-warning` (darkened in light mode)  | Warnings                                   |
| `--*-soft`         |           |           | `kumo-*-tint` over `--surface`                | The tone's background                      |
| `--ring`           | `#155dfc` | `#51a2ff` | `focus-visible:ring-kumo-brand`               | Keyboard focus ring (2 px)                 |
| `--field-focus`    | `#858585` | `#808082` | `ring-kumo-focus/50`                          | Focused field border (1.5 px)              |
| `--backdrop`       |           |           | `bg-kumo-recessed` at 80 %                    | Behind dialogs and the More sheet          |
| `--logo`           | `#b4233c` | `#f27a8e` | Ruby                                          | Ruby's mark only                           |

**Where Ruby departs from Kumo, and why.**

- Kumo's subtle text (`#737373`) is 4.35:1 on a tint, so `--muted` is `#666666` in light mode.
- Kumo's warning text (`#bd6500`) is 4.18:1 on white, so `--warning` is `#9a5700` in light mode.
- Kumo's primary button blends 15 % white into its gradient top, which drops the white label below 4.5:1. Ruby fills
  the button with solid `--brand`, adds a 1 px top highlight and a darker 1 px edge, and uses `#155dfc` (5.25:1).
- Kumo outlines fields with `kumo-line` (1.3:1). WCAG 1.4.11 needs 3:1 for a field's boundary, so Ruby uses
  `--border-control`.
- Banners get a 1 px border in their own colour at 22 %, because Kumo's very light tints are hard to see on white.
- In the tab bar, the current tab is marked by Kumo's 2 px underline bar, moved to the tab's top edge.

**Other scales.**

- **Type:** Geist (self-hosted, OFL). Kumo's docs use Inter, but the Kumo library ships no font, so Ruby keeps Geist.
  The sizes are `--text-xs` 12, `--text-sm` 13, `--text-base` 14, `--text-lg` 16, `--text-xl` 18 and `--text-2xl` 24
  px. Page headings are 24 px (22 px on phones), weight 600, letter-spacing -0.02em. Fields stay at 16 px or larger
  (iOS zoom).
- **Radius:** `--radius-s` 6 px for small buttons, menu items and segmented tabs. `--radius-m` 8 px for buttons and
  fields. `--radius-l` 8 px for cards and lists (Kumo `rounded-lg`). `--radius-xl` 12 px for dialogs, sheets, toasts
  and the empty state.
- **Shadow:** `--shadow-1` (Kumo `shadow-xs`) for buttons and cards. `--shadow-2` (Kumo `shadow-lg`) for menus, sheets,
  dialogs and toasts. A shadow is always paired with a 1 px `--border`.
- **Motion:** `--dur-fast` 100 ms for colour and state changes. `--dur` 150 ms for overlays. `--ease` is the standard
  curve. Each component turns its own animation off under `prefers-reduced-motion`. There is no global
  `transition-duration` override: one would make every property change transition, layout changes included.

## Base styles

- `:focus-visible` draws a 2 px `--ring` outline, offset 1 px. Fields draw a 1.5 px `--field-focus` border instead.
- Checkboxes and radios are styled globally: a 16 px box with `--border-control`, filled with `--fg` and a
  `--surface` check mark when checked, and support for the indeterminate state. A bare `<input type="checkbox">` in a
  feature looks the same as the kit's Checkbox. A switch (`role="switch"`) is excluded from this style.
- `.sr-only` is pinned with `left: 0`. A hidden label inside a sideways-scrolling box (the board's far columns) would
  otherwise escape the box at its static position and widen a phone's layout viewport.
  `e2e/board-overflow.spec.ts` and the stricter `expectNoHorizontalOverflow` check this: the layout viewport must
  stay at the device width.
- Rendered Markdown (`.markdown`): headings use `--fg-strong`, links use `--accent` with a 40 % underline, and code,
  `pre` and tables have a `--border` edge on `--elevated`.

## Kit components (`src/lib/ui/kit/`)

Each component starts with a header comment that states its contract. All of them work at 360 px and are at least
44 px tall on coarse pointers.

| Component                     | Kumo counterpart   | Notes                                                                                                                                             |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                      | Button             | `primary` (blue fill), `secondary` (line border), `ghost`, `danger` (red text). 36 px (`md`) or 28 px (`sm`). `loading` disables it and spins. |
| `TextField`, `TextArea`       | Input, InputArea   | 36 px, `--control` background, `--border-control` border, 1.5 px focus ring, `aria-invalid` and `aria-describedby` wired.                         |
| `Select`                      | Select             | Native `<select>` with a CSS chevron. Keeps a choice made before hydration (RB-06 QA D1).                                                        |
| `Checkbox`                    | Checkbox           | Native checkbox plus label, description and error. Works without JavaScript.                                                                      |
| `Switch`                      | Switch             | Native checkbox with `role="switch"`, a 36 × 20 track with a 6 px radius (Kumo's squircle). Posts like a checkbox.                                |
| `Badge`                       | Badge              | 20 px pill, 12 px medium text. Tones: neutral, accent, success, warning, danger.                                                                  |
| `Banner`                      | Banner             | Tint background, tone text. Error is `role="alert"`; the others are `role="status"`.                                                              |
| `Card`                        | LayerCard          | Bordered surface with an optional header (title at level 2 to 4, description, actions). `flush` removes the body padding for edge-to-edge content. |
| `Table`                       | Table              | Focusable scroll region named by its caption. Kumo spacing; `compact` header; `.num` cells.                                                       |
| `Tabs`                        | Tabs               | `underline` or `segmented`. Items with `href` form a `<nav>` with `aria-current`; items without form an ARIA tablist with arrow keys.            |
| `Dialog`                      | Dialog             | Native `<dialog>` with `showModal()`. Focus is trapped and returns to the opener; Escape and a backdrop click close it; `sheet` on phones.        |
| `DropdownMenu`                | Dropdown           | ARIA menu button. Items are links, callbacks or POST forms. Arrow keys, Home, End and Escape work, and outside clicks close it.                  |
| `Toaster` + `toast.svelte.ts` | Toast              | `showToast()` only after the server confirms a write. Polite live region; an error toast is an alert. Max 3 toasts, 5 s each.                    |
| `EmptyState`                  | Empty              | Bordered 12 px panel with a 16 px heading, text and one action.                                                                                   |
| `PageHeader`                  | blocks/page-header | The page's `<h1>` (24 px) with a description and actions.                                                                                         |
| `Avatar`, `Icon`, `FieldError`, `LocalTime`, `Markdown` | | These keep their behaviour and take the new tokens. |

**Rules.**

1. Use one primary button per view. Use `danger` for destructive buttons, and confirm the action with a checkbox or a
   dialog.
2. Pages use `PageHeader`. Blocks go in a `Card` or in a bordered list (`--border`, `--radius-l`, `--surface`).
3. Show state with words as well as colour. Badges carry text.
4. Never make a dialog, menu or toast the only route to an action: each one needs JavaScript.
5. Show a toast only after the server has confirmed the write. Show errors that need action in a `Banner` next to the
   form.

## App shell (`src/routes/(app)/+layout.svelte`)

- **768 px and wider:** a 232 px white sidebar with a `--border` right edge. The 52 px brand row has a hairline under
  it. Nav items are 34 px high, 13 px medium text, with muted icons. The current item and hovered items sit on
  `--surface-2`. The account row is at the bottom, above a hairline. The content area is the `--bg` canvas, at most
  1120 px wide.
- **Below 768 px:** a blurred top bar and a fixed five-tab bottom bar, both padded by the `--sai-*` safe areas. The
  current tab has `--fg` text and a 2 px `--brand` bar. The More sheet is a Kumo menu: `--control` background,
  12 px radius, `--shadow-2`, with sign-out below a divider. It opens over a `--backdrop`.
- The `Toaster` sits above the tab bar on phones and at the bottom right from 768 px.

## Screenshots

`docs/design/screenshots/` holds review screenshots of seven screens: home, project board, task, KB page, people,
admin users and sign-in. Each screen is taken at 402 × 874 and 1280 × 800, in light and in dark. To regenerate them:

```sh
RUBY_SCREENSHOTS=1 RUBY_E2E_PORT=4451 npx playwright test e2e/screenshots.spec.ts --project=iphone-402
RUBY_SCREENSHOTS=1 RUBY_E2E_PORT=4451 npx playwright test e2e/screenshots.spec.ts --project=desktop
```

Run the two projects one after the other. Both create the same fictional project the first time they run.
