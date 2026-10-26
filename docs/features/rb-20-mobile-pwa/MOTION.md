# RB-20 Part B — Motion

> Calm, functional animation for the Ruby app UI, shipped with the mobile/PWA work in 0.5.0: it explains what changed (a sheet opened, a card moved, a row was saved)
> and never decorates. Everything is off under reduced motion, uses only `transform` and `opacity`, and needs no new dependency.

## Summary

| Field | Value |
| --- | --- |
| ID | RB-20 Part B (extends `docs/features/rb-20-mobile-pwa/PRD.md`) |
| Status | Approved (owner defaults 2026-10-26) |
| Risk tier | **Medium**: touches the shared kit (Dialog, Toaster, Tabs), the shell, the board DnD and navigation; no data, auth or schema change |
| Release version | 0.5.0 (same release as RB-20 Part A, PR #18; one line added to the release note) |
| Migration | none |
| Depends on | RB-20 Part A (standalone mode, safe areas, UpdateBanner, offline indicator), RB-10 Kumo tokens, RB-18 board |
| Owner | Owner (request 2026-10-26: "add visual animation too") |
| Date | 2026-10-26 |

Approach: token-mirrored script constants, a CSS lint test and a small budget of motion, all described on Ruby's own terms.

## Contents

1. [Goal and user value](#1-goal-and-user-value)
2. [Scope](#2-scope)
3. [Current behaviour this builds on](#3-current-behaviour-this-builds-on)
4. [Design](#4-design)
5. [Routes and UI](#5-routes-and-ui)
6. [Data and migrations](#6-data-and-migrations)
7. [Limits](#7-limits)
8. [Authorization](#8-authorization)
9. [Concurrency and failure states](#9-concurrency-and-failure-states)
10. [Mobile and accessibility](#10-mobile-and-accessibility)
11. [Security and privacy](#11-security-and-privacy)
12. [Acceptance criteria](#12-acceptance-criteria)
13. [Test plan](#13-test-plan)
14. [Owner decisions](#14-owner-decisions)
15. [Out of scope / later](#15-out-of-scope--later)
16. [Release note draft](#16-release-note-draft)

## 1. Goal and user value

On a phone, Ruby swaps pages and opens sheets with hard cuts, so a user cannot always tell what just happened: did the card move, did the comment post, did
the sheet close? Short motion answers those questions. The rule is "motion explains a change". Anything that does not explain a change stays still.

## 2. Scope

**In**

- Motion tokens: `--dur-fast` 120 ms, `--dur` 200 ms, `--dur-slow` 280 ms, plus `--ease`, `--ease-out`, `--ease-in` in `src/app.css`.
- Page transition (View Transitions API via `onNavigate`, phones only by default).
- Enter/exit for the More sheet (CSS only), Dialog, DropdownMenu, Toaster, UpdateBanner and the offline banner.
- Board: card move/reorder FLIP, drop feedback, column-count change.
- Lists: insert/remove for comments, notifications, checklist steps; "just saved" row highlight.
- Feedback: button pressed state, form-save success tick, skeleton shimmer where skeletons exist today.
- Calendar month/week/agenda switch.
- A small module `src/lib/ui/motion.ts` (constants, `reducedMotion()`, `flipAllowed()`, `pageTransitionAllowed()`) and two tests (CSS lint, Playwright reduced motion).

**Out**: see [section 15](#15-out-of-scope--later).

## 3. Current behaviour this builds on

Line numbers are on branch `feat/rb-20-mobile-pwa` at `5e34e45`; the engineer re-checks them.

- `src/app.css:99-102`: Kumo motion tokens `--dur-fast` 100 ms, `--dur` 150 ms, one `--ease`. `docs/design/DESIGN_SYSTEM.md:78-80`: each component switches its own animation off under
  `prefers-reduced-motion`; there is deliberately **no** global `transition-duration` override (it would animate layout). This PRD keeps that rule.
- `src/lib/ui/kit/Dialog.svelte:56-120`: native `<dialog>`, `showModal()`, already enters with `@starting-style` (opacity + `scale(0.96)`) and `overlay`/`display` `allow-discrete`; `transition: none` under reduce. Desktop-style only; no phone sheet variant.
- `src/lib/ui/kit/Toaster.svelte:61-72`: a `rise` keyframe on enter (8 px, 150 ms); no exit animation; none under reduce.
- `src/lib/ui/kit/Tabs.svelte:116`, `DropdownMenu.svelte:179`: colour transitions only. The menu has no enter/exit.
- `src/routes/(app)/+layout.svelte:180-221`: the phone More sheet is a `<details class="more">` with `<div class="sheet">`; `ontoggle` sets `moreOpen`, which renders a `.backdrop` button (`:223`). It opens without JS and must keep doing so. `:171` mounts `UpdateBanner`.
- `src/lib/ui/tasks/Board.svelte:336-369`: `{#each columns as column (column.status)}` and `{#each column.tasks as card (card.id)}` are already keyed, so `animate:flip` works. `:424` has the `<details class="move">` keyboard/phone move control.
- `src/lib/ui/comments/CommentThread.svelte:55` and `src/routes/(app)/notifications/+page.svelte:90` render keyed `{#each}` lists.
- Skeletons exist in `projects/+page.svelte:29` and `:137`, `projects/[key]/+page.svelte:94` and `:252`, `people/+page.svelte:92`. They are static today.
- `src/routes/(app)/calendar/+page.svelte:49-95`: view tabs and step links are plain `<a href>` navigations; the page re-renders from `load`.
- `src/lib/server/csp.ts:13-15`: `style-src 'self'`; `style-src-attr` allows one hash only. No `onNavigate` is used anywhere yet.
- `playwright.config.ts:43`: **every e2e run already uses `reducedMotion: 'reduce'`**, so existing specs never see motion. Part B must keep that default and add one dedicated project/spec with motion on.

## 4. Design

### 4.1 Principles

1. **Motion explains a change**: spatial (where did it go), causal (this tap did that) or status (it saved). Nothing runs on page load for its own sake; no looping animation except the skeleton shimmer.
2. **Only `transform` and `opacity`.** Never `width`, `height`, `top`, `left`, `margin`, `padding`. (Colour/background transitions on hover are the existing exception and stay at `--dur-fast`.)
3. **Quiet.** Distances 8 px or less for content, one sheet-height for sheets, `scale` between 0.96 and 1.
4. **Reduced motion is the default state of the code.** Movement lives inside `@media (prefers-reduced-motion: no-preference)`; the base rule has none. Under reduce: no movement; opacity cross-fade of at most `--dur-fast` for sheets/toasts, nothing for lists and board.
5. **Same behaviour with or without motion.** Focus, ARIA and DOM order never depend on an animation ending (no `animationend`/`transitionend` gating).

### 4.2 Tokens

In `src/app.css` `:root` (the Kumo block at `:99`). Existing names are kept so no component changes its reference.

| Token | Value | Use |
| --- | --- | --- |
| `--dur-fast` | 120 ms (was 100) | press, hover colour, highlight fade-in, checkbox |
| `--dur` | 200 ms (was 150) | enter/exit of menus, toasts, banners, list rows, board FLIP |
| `--dur-slow` | 280 ms (new) | sheets, dialogs on phones, calendar switch |
| `--dur-loop` | 1200 ms (new) | skeleton shimmer, the only `infinite` animation |
| `--ease` | `cubic-bezier(0.4, 0, 0.2, 1)` (unchanged) | state changes |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` (new) | entering things |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` (new) | leaving things (shorter: use `--dur-fast`) |

The 100 to 120 ms and 150 to 200 ms change is intentional and tiny; the CSS test in 13.1 pins the new values. Page transitions (View Transitions) are the only thing allowed above 280 ms in principle, and are set to `--dur` (200 ms) anyway.

`src/lib/ui/motion.ts` mirrors the numbers for script use (Svelte transition params, which need milliseconds), and a Vitest test asserts the constants equal the CSS tokens:

```ts
export const DURATION_MS = { fast: 120, base: 200, slow: 280 } as const;
export const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
export const FLIP_MAX_ITEMS = 50;
export function reducedMotion(): boolean;           // matchMedia, false on the server
export function flipAllowed(count: number): boolean; // !reducedMotion() && !hidden && count <= FLIP_MAX_ITEMS
export function pageTransitionAllowed(i: { phone: boolean; supported: boolean; from?: string; to?: string }): boolean;
```

Script-driven motion also never runs in a hidden tab (`document.hidden`): the end state is simply there when the tab returns.

### 4.3 Page transitions

- `src/routes/+layout.svelte` (root, so sign-in pages too) calls SvelteKit `onNavigate`. If `pageTransitionAllowed(...)` it returns a promise that runs `document.startViewTransition(async () => { resolve(); await navigation.complete; })`; otherwise it returns nothing (no-op where `startViewTransition` is missing, on desktop under default O1, under reduce, in a hidden tab, or for same-path navigations such as a filter change).
- Phones = `matchMedia('(max-width: 767px)')`, the same breakpoint as the shell's phone layout (confirm against `+layout.svelte`).
- Effect: cross-fade, with the incoming page rising 8 px. CSS only, in `app.css`, inside `@media (prefers-reduced-motion: no-preference)`: `::view-transition-old(root)` fades out in `--dur-fast`, `::view-transition-new(root)` fades in and translates in `--dur`. Under reduce the pseudo-elements are `animation: none`, and the code never starts a transition anyway.
- The tab bar, top bar and More backdrop get `view-transition-name` (set in a stylesheet class, not inline) so they stay put and only `<main>` animates. Names are unique; at most 4 named elements.
- **Known risk (known browser behaviour):** Chromium drops taps while a view transition runs, so a fast second tap on the next page was lost, which is why a Web Animations fade on `<main>` is the fallback. Mitigations here: 200 ms total; the transition is skipped (`transition.skipTransition()`) on a new `pointerdown`; and if the Playwright tap test (B-AC4) fails on Chromium or WebKit, the engineer switches to the WAAPI fallback (O2) without asking. The user-visible behaviour is the same.
- At most one page transition runs at a time: a new navigation skips the running one.
- RB-20 interaction: standalone mode and the standalone back control (Part A, 4.13) navigate through the same path, so a back navigation fades the same way (no direction-aware slide in this pass). The transition never covers the safe areas: the named shell elements keep their padding from `--sai-*` and `<main>` is the only snapshot that moves. `UpdateBanner`'s `beforeNavigate` guard (`UpdateBanner.svelte:17`) runs first; a cancelled navigation starts no transition.

### 4.4 Sheets, dialogs, menus

- **More sheet (CSS only, works without JS).** `<details class="more">` is not changed in markup. The `.sheet` panel is a normal-flow child that `details` shows/hides with `display`, so it enters with `@starting-style` + `transition` on `transform`/`opacity` for the open state (`details[open] > .sheet { transform: none; opacity: 1 }`, `@starting-style` from `translateY(16px)` and opacity 0), `--dur-slow` `--ease-out`. Exit uses `transition-behavior: allow-discrete` plus `content-visibility`/`::details-content` where supported; where unsupported the sheet simply closes with no exit animation (acceptable; entering is the part that explains). The `.backdrop` button (rendered by JS only) fades in with `opacity` and `@starting-style`; no JS means no backdrop and no change from today. Nothing on this path is gated on JS.
- **Dialog** (`Dialog.svelte`): keep the existing desktop behaviour (opacity + `scale(0.96)`, now `--dur`). On phones (max-width 767px) the dialog becomes a bottom sheet: `translateY(100%)` to `0`, `--dur-slow`, `--ease-out`; it respects `padding-bottom: var(--sai-bottom)` (already there). Backdrop fades with `opacity`. Exit mirrors enter, via the existing `allow-discrete` pair. `<dialog>` focus handling is untouched.
- **DropdownMenu**: opens with `opacity` 0 to 1 and `translateY(-4px)` to 0 (`scale(0.98)` from the trigger side is skipped: no transform-origin math), `--dur-fast`. Closes with opacity only, `--dur-fast`. Uses `@starting-style` if the menu is a popover/`[hidden]`-toggled element; otherwise a Svelte `transition:fade|fly` (see 4.9).
- Under reduce: sheet/dialog/menu fade by opacity in `--dur-fast`, no transform (the sheet is the one place opacity-only motion is kept, because an instant swap of a full-width layer is jarring and opacity is not movement).

### 4.5 Board

Files: `Board.svelte`, plus the `+page` that hosts it if the drop handler lives there.

- **Card move/reorder**: `animate:flip={{ duration: DURATION_MS.base, easing }}` on the keyed `{#each column.tasks as card (card.id)}`. `flip` animates `transform` only. It is applied only when `flipAllowed(total cards on the board) `; above 50 cards on screen the directive receives `duration: 0` (the card just appears in its new place). The 50 cap counts rendered cards across all columns, since cards in different columns do not FLIP together anyway.
- Cross-column move: the card is removed from one keyed list and added to another, so `animate:flip` does not carry it. Use `in:`/`out:` with `crossfade` from `svelte/transition` (a keyed pair per card id) so the card visibly travels from the old column to the new one (`transform` + `opacity`, `--dur`). If a card has no counterpart (new task) it fades in at `--dur-fast`.
- **Drop feedback**: while dragging, the target column's drop zone gets a `.drop-target` class (outline and background colour, no layout change; colour transition `--dur-fast`). On drop, the card gets `.just-moved` for one 600 ms-long colour highlight (background fades from `--accent-soft` to transparent; opacity-only overlay via `::after`, since background-color is paint-only and cheap, but we keep it in the highlight pattern in 4.6).
- **Column-count feedback**: when a card is added/removed the column header's count badge plays a one-shot 1 to 1.12 to 1 `scale` (`--dur`) keyed by `{#key count}` on a tiny inner `<span>`. Not on first render (a `mounted` flag skips the first value).
- **Keyboard and phone move** (`<details class="move">`, `:424`): the same state change drives the same FLIP, so moving with the keyboard or the phone menu animates identically. Focus must stay on the moved card's control after the move; FLIP must not re-create the element (keyed each guarantees it).
- Under reduce: no FLIP, no crossfade, no count pop. The column highlight stays (colour only).

### 4.6 Lists and "just saved"

- **Insert/remove** on keyed `{#each}`: comments (`CommentThread.svelte:55`), notifications (`notifications/+page.svelte:90`), checklist steps. New row: `in:fly={{ y: 8, duration: DURATION_MS.base }}` (opacity + transform). Removed row: `out:fade={{ duration: DURATION_MS.fast }}` and the list closes the gap with `animate:flip` on the siblings (cap 50 items: above that, durations are 0).
- Svelte only plays `in:` for rows inserted **after** hydration if the transition is `|local`. All list transitions use `|local` so the first render (page load, 100 rows) plays nothing, and a parent block being created or destroyed does not trigger every row. This is the rule that keeps "nothing runs on page load for every element".
- **Just saved**: after a successful form action (comment posted, task edited, checklist step added), the affected row gets `data-saved` for 1200 ms. CSS: an `::after` overlay with `background: var(--accent-soft)` that fades `opacity` 1 to 0 over `--dur-slow` (no layout, no repaint of text). The id to highlight comes from the action result or from `page.form`/`$page.state` that the page already uses; no new server field is needed except where an action does not return the created id (then no highlight, never an extra query). Never highlights on load or reload (needs an action result newer than the page).
- Under reduce: rows appear and disappear instantly; the saved highlight is a static tint that is removed after 1200 ms with no fade (opacity is not animated; colour tint only).

### 4.7 Feedback

- **Toaster** (`Toaster.svelte`): enter keeps the `rise` keyframe at `--dur`; add the exit. Exit uses Svelte `out:fade|local` over `--dur-fast` so a dismissed toast does not vanish abruptly and the stack closes with `animate:flip`. At most 3 toasts visible (existing cap if any; else a new cap of 3). Under reduce: opacity only.
- **Button pressed**: `Button.svelte` `:active:not(:disabled) { transform: scale(0.97) }` with `transition: transform var(--dur-fast) var(--ease)`. Same for icon buttons, tab bar links and `.sheet-link`. Under reduce: no transform; the existing background change on `:active` stays as the only feedback.
- **Form save success**: the submit button swaps its label to "Saved" with a check icon for 1500 ms, the check scaling 0.8 to 1 and fading in at `--dur-fast`. The label swap is text, not animated. `aria-live="polite"` announces "Saved" (already used by the toasts; no double announcement: the check is `aria-hidden`).
- **UpdateBanner** (`UpdateBanner.svelte` in the shell): slides in 8 px from the top (phone: from above the tab bar, never from under the safe-area) and fades, `--dur`. Exit fade at `--dur-fast`. It appears only after a version change is detected, so it never plays on first load.
- **Offline banner** (Part A 4.13 offline indicator): fade + 8 px rise on show and fade on hide, `--dur`. No pulse, no looping dot.
- **Skeleton shimmer**: only where a skeleton exists today (the three above). A `::after` gradient moves with `transform: translateX(-100%)` to `100%`, `--dur-loop`, `infinite`. It is the **only** `infinite` animation allowed, and only inside an element with `aria-busy="true"`; the test enforces both. Under reduce: static grey bars, no shimmer. The skeleton shows after a 200 ms delay (opacity 0 to 1 over `--dur-fast` after `animation-delay: 200ms`) so fast loads flash nothing.

### 4.8 Calendar

The month/week/agenda switch and the previous/next steps are navigations. They get a **directional** one-shot on the grid only (not the page): `translateX(8px)` to 0 with opacity, `--dur-slow`, 280 ms, chosen by a `data-dir` attribute (`next` / `prev` / `none`) set from the destination in `afterNavigate`. A view switch (month to week) uses an opacity + `scale(0.98)` to 1 instead. Not played on first load. On phones with page transitions on, the grid animation is suppressed on view switches to keep one motion at a time (budget: one page-level motion).

### 4.9 Implementation notes: Svelte transitions and CSP

- Svelte 5 `transition:`/`in:`/`out:`/`animate:` run as Web Animations (`element.animate()`) when the browser supports it. WAAPI keyframes are not CSS text and are not governed by `style-src`; nothing writes a `style="..."` attribute or injects a `<style>` tag, so `style-src 'self'` and `style-src-attr` stay as they are (`csp.ts:13-15`).
- **Risk** to verify, not assume: old Svelte code paths and some custom transitions write `element.style`. CSSOM writes (`el.style.x = ...`) are not blocked by CSP, but `setAttribute('style', ...)` is. The engineer adds a Playwright check (B-AC12) that listens for `securitypolicyviolation` and console errors during every motion spec and fails on any. Custom transitions must return `{ duration, css }` or `{ duration, tick }`, never touch `style` attributes.
- Dialog, sheet, menu and shell motion are **pure CSS** (no JS). Only the board, lists and toasts use Svelte directives.
- No new dependency: `svelte/transition`, `svelte/animate` and `svelte/easing` ship with Svelte; the View Transitions API is the browser's.
- `will-change` is never set globally. Where a long FLIP needs it, the browser handles it; the stylesheet has zero `will-change` (a test checks).

### 4.10 Budgets

| Budget | Limit | How it holds |
| --- | --- | --- |
| Concurrent page-level transitions | 1 | a new navigation skips the running view transition; the calendar grid motion is off while a page transition is on |
| Longest animation | 300 ms, except the page transition (200 ms by default, hard cap 400 ms) | CSS test: every duration is a token or 0; tokens max 280 ms |
| List FLIP | at most 50 items, else skipped | `flipAllowed()` |
| `infinite` animations | only skeleton shimmer | CSS test whitelist |
| Elements animated on page load | 0 | `|local` transitions, `@starting-style` only on elements created after load, no `animation` on `:root`/`body`/`main` outside view-transition pseudo-elements |
| Concurrent toasts | 3 | existing cap or new |
| Properties | `transform`, `opacity` (and `background-color`/`color` on hover only) | CSS test |

### 4.11 RB-20 PWA interaction

- **Standalone**: no difference in motion code. The same tokens apply; `display-mode: standalone` does not add or remove animations, except the page transition is on there too on phones (O1).
- **Back control**: back navigation uses the same page transition; no reverse slide.
- **Safe areas**: sheets and bottom-sheet dialogs animate `transform` of an element that already includes `--sai-bottom` padding, so the sheet never lifts above or sinks below the home indicator; banners start inside the top safe area, not under the status bar. Only `app.css` reads `env(safe-area-inset-*)` (existing test `test/css.test.ts`); no motion file reads it.
- **Service worker / offline**: the offline page (static HTML, Part A) has no script; it may include the same CSS fade-in (opacity, 200 ms, `prefers-reduced-motion` guarded) or nothing. Default: nothing.
- **overscroll**: `overscroll-behavior: contain` on the sheet is unchanged; the sheet animation must not enable page scroll behind it.

## 5. Routes and UI

No route changes. Files touched (the engineer's map, not code):

| Area | Files |
| --- | --- |
| Tokens and global CSS | `src/app.css` (tokens, view-transition pseudo-elements, press state utility if shared) |
| Motion module | `src/lib/ui/motion.ts` (new), `src/lib/ui/motion.test.ts` (new) |
| Shell | `src/routes/+layout.svelte` (`onNavigate`), `src/routes/(app)/+layout.svelte` (More sheet CSS, backdrop, named elements), `src/lib/ui/shell/UpdateBanner.svelte`, the Part A offline banner component |
| Kit | `Dialog.svelte`, `DropdownMenu.svelte`, `Toaster.svelte`, `Button.svelte`, `Tabs.svelte` (indicator or colour only) |
| Board | `src/lib/ui/tasks/Board.svelte` |
| Lists | `CommentThread.svelte`, `notifications/+page.svelte`, checklist component |
| Skeletons | `projects/+page.svelte`, `projects/[key]/+page.svelte`, `people/+page.svelte` |
| Calendar | `calendar/+page.svelte` |
| Release note | `src/lib/content/releases/0.5.0.md` (one line) |

## 6. Data and migrations

None. No schema, no stored preference. The motion setting is the OS `prefers-reduced-motion` only. A per-user "Reduce animations" toggle is out of scope (O5).

## 7. Limits

- Durations: 120 / 200 / 280 ms. Shimmer loop 1200 ms.
- List FLIP: 50 items. Toasts: 3. Skeleton rows: no change from today.
- Page transition: 1 at a time; cap 400 ms in CSS, default 200 ms.
- Named view-transition elements: 4.

## 8. Authorization

No route, load, action or download changes. Motion is presentation only. The "just saved" highlight uses ids already returned to the signed-in user by the action; no id from another user is exposed. `requireUser`/`requireAdmin` untouched.

## 9. Concurrency and failure states

- Rapid repeated actions (drag several cards, post two comments quickly): FLIP and `in:` transitions are interruptible by design (Web Animations replace the running animation); the final DOM order is the source of truth.
- A failed save: no success tick, no highlight; the existing error state shows. A server redirect or a load that reorders rows after an optimistic move shows the final order after at most one FLIP.
- `startViewTransition` throws or is skipped: the navigation proceeds with no transition. The `onNavigate` callback never delays a navigation more than the transition's own `ready` promise (and never waits on a hidden tab).
- Data arriving during an animation (new comment via invalidate): the list animates the insert; nothing blocks input.
- Hidden tab / bfcache restore: no animations run; the page is in its end state.

## 10. Mobile and accessibility

- `prefers-reduced-motion: reduce`: no `transform` animation or transition anywhere, no shimmer, no FLIP, no View Transition. Opacity-only fades of at most `--dur-fast` for sheets, dialogs, menus and toasts; none for lists and board. Highlight is a static tint.
- Motion never carries meaning alone: every state change also has text/ARIA (toast text, `aria-live`, "Saved", `aria-current`).
- No flashing: nothing flickers more than 3 times a second; the shimmer is a slow gradient.
- Touch: the press state gives immediate feedback at `--dur-fast`; no 300 ms delays; sheets are not blocked from interaction during their enter animation.
- Focus: `<dialog>` and the More sheet keep native focus handling; focus never waits for an animation; focus rings are not animated away.
- Hit targets are unchanged (44 px, Part A).

## 11. Security and privacy

- CSP stays as is (4.9). The View Transitions snapshot is a screenshot of the DOM held in memory by the browser; it does not leave the page. Because a snapshot of the previous page is shown while navigating, and Ruby holds private HR data, **the sign-out and the account switch navigate with no transition** (`onNavigate` returns when `to.url.pathname` is `/logout` or `/login`), so a previous user's page never fades on a shared phone.
- No third-party code, fonts or images. No `eval`, no inline `<style>`.
- Markdown output safety unchanged: no animation touches rendered Markdown HTML.

## 12. Acceptance criteria

Levels per `docs/ACCEPTANCE.md`: [A] Automated, [M] Mocked, [P] Pass (manual on a real device).

- [ ] B-AC1 [A] `src/app.css` defines `--dur-fast: 120ms`, `--dur: 200ms`, `--dur-slow: 280ms`, `--dur-loop: 1200ms`, `--ease`, `--ease-out`, `--ease-in`; `DURATION_MS` and the easing strings in `src/lib/ui/motion.ts` equal them.
- [ ] B-AC2 [A] The CSS lint test (13.1) passes: every `transition-duration`, `animation-duration` and the shorthands use a token or `0s`/`none`; no `infinite` outside the skeleton shimmer; keyframes and transitions touch only `transform`, `opacity` (and `background-color`/`color`/`border-color` for hover/press); no layout property; no `will-change`.
- [ ] B-AC3 [A] Every rule that moves (a `transform`/`translate`/`scale` animation or transition) is inside `@media (prefers-reduced-motion: no-preference)` or has a `prefers-reduced-motion: reduce` override setting it to `none`; the `::view-transition-*` rules are no-preference only.
- [ ] B-AC4 [A] On a phone viewport, with motion on (project `motion`), a tab-bar link click then an immediate second tap on the next page is not lost on Chromium; the navigation completes within 600 ms; on WebKit the same passes or the WAAPI fallback (O2) is in use.
- [ ] B-AC5 [A] `onNavigate` starts a view transition only on a phone viewport (default O1), when `document.startViewTransition` exists, not under reduce, not in a hidden tab, not when only the query string changes, and never for `/logout` or `/login`. With no support or on desktop the navigation is unchanged (unit test of `pageTransitionAllowed()`; Playwright asserts no `::view-transition` pseudo-elements on desktop).
- [ ] B-AC6 [A] The More sheet opens and closes with JavaScript disabled (Playwright `javaScriptEnabled: false`): `details[open]` shows the links; the enter animation is pure CSS (the stylesheet has no `.sheet` rule that needs a class set by script). With JS on, the backdrop still closes it.
- [ ] B-AC7 [A] On a phone viewport the Dialog is a bottom sheet (`translateY`), on desktop it scales from 0.96; focus moves into the dialog on open and returns to the opener on close, with motion on and with reduce.
- [ ] B-AC8 [A] Board: moving a card by mouse drag, by keyboard and by the phone move control updates the order and runs FLIP (the card has a running `Animation` on `transform` for at most 200 ms under motion; none under reduce). With 51 or more cards rendered, no animation runs. Focus stays on the moved card's control.
- [ ] B-AC9 [A] Lists: a comment posted after load plays an `in:` animation and gets `data-saved` for 1200 ms; the initial render of 100 notifications creates zero `Animation` objects (`document.getAnimations().length === 0` right after load).
- [ ] B-AC10 [A] Toasts: an exit animation runs on dismiss (motion on); at most 3 visible; the toast text is in an `aria-live` region and readable with motion off.
- [ ] B-AC11 [A] Under `reducedMotion: 'reduce'`, `document.getAnimations()` contains no animation whose keyframes include `transform` or `translate`/`scale`, on: first load, a page navigation, opening the More sheet, opening a dialog, a board move, a comment post, a toast, and the calendar switch. Computed `transition-duration` of sheet, dialog, toast and card is `0s` or opacity-only `0.12s`.
- [ ] B-AC12 [A] During every motion spec there is no `securitypolicyviolation` event and no console error mentioning CSP; the response CSP header is unchanged (`style-src 'self'`).
- [ ] B-AC13 [A] The skeleton shimmer exists only inside `aria-busy="true"` elements, is delayed 200 ms, and is not rendered under reduce.
- [ ] B-AC14 [A] The UpdateBanner and the offline banner animate in only when they appear after load (no `Animation` on a clean load); both are visible and operable immediately under reduce.
- [ ] B-AC15 [A] Calendar: month to week and previous/next set `data-dir`; the grid animates once (motion on) and not at all under reduce; the page-transition and grid animation never overlap on a phone (`getAnimations()` count at most 1 page-level animation).
- [ ] B-AC16 [A] The existing e2e specs (`shell`, `board-overflow`, `calendar`, `comments`, `kit-hydration`, and all `rbNN-qa`) pass unchanged with the default `reducedMotion: 'reduce'`, and `board-overflow` / `shell` also pass in the `motion` project (no horizontal overflow introduced by `translateX` entry animations, checked at 360, 402 and 1280 px).
- [ ] B-AC17 [A] Standalone: with `display-mode: standalone` emulated, a bottom-sheet Dialog and the More sheet do not paint under the home indicator or the status bar at any frame we sample (bounding box within the visual viewport minus `--sai-*`), and `test/css.test.ts` safe-area rules still pass.
- [ ] B-AC18 [A] No new dependency: `package.json` dependencies and `devDependencies` are unchanged by Part B; `THIRD_PARTY_NOTICES.md` unchanged.
- [ ] B-AC19 [A] Component render tests (Vitest/SSR) pass for Dialog, Toaster, Board, CommentThread and UpdateBanner: markup, ARIA roles and keyed ids are identical with and without motion props; no `style=` attribute is rendered by motion code.
- [ ] B-AC20 [P] On a real iPhone (installed) and a real Android phone: page transition, More sheet, a card move, a toast and the UpdateBanner feel smooth (no dropped taps, no flicker, no lag); with OS "Reduce Motion" on, nothing slides.

## 13. Test plan

### 13.1 Vitest: `test/motion-css.test.ts`

Parses every `.svelte` `<style>` block and `src/app.css` (a small helper in `test/helpers/css.ts`, tracking `@media` / `@keyframes` context). Asserts:

1. Every duration in `transition`, `transition-duration`, `animation`, `animation-duration` is `var(--dur-fast|--dur|--dur-slow|--dur-loop)`, `0s` or `none`; every easing is `var(--ease*)` or `linear` for the shimmer.
2. Keyframes only change `transform`, `opacity` (plus `translate`, `scale`); transitions on hover/active only add `background-color`, `color`, `border-color`, `box-shadow`-free.
3. No `will-change`, no `width|height|top|left|right|bottom|margin|padding` in a `transition` or `@keyframes`.
4. Any rule with a `transform`/`translate`/`scale`/`rotate` in a `transition` or `animation` sits under `no-preference`, or the same selector has a `reduce` override with `none`/`transform: none`.
5. `infinite` appears only in a file on the whitelist (the skeleton files) and the selector is inside an `aria-busy` block.
6. A new motion file list (`MOTION_FILES`) must include every file that contains `animation` or `transition`; an unlisted file with motion fails (so new motion cannot slip past the lint).
7. `motion.ts` constants equal the `app.css` tokens.
8. `app.css` has zero motion on `:root`, `body`, `main` or `*` apart from `::view-transition-*`.

### 13.2 Vitest: `src/lib/ui/motion.test.ts`

`DURATION_MS`, `flipAllowed(0|50|51)`, `pageTransitionAllowed` truth table (phone/desktop, supported, reduce, hidden, same path), and that `reducedMotion()` is false on the server.

### 13.3 Vitest: component render tests

Per component (B-AC19): Dialog (phone/desktop class, `role`, focus attributes), Toaster (max 3, `aria-live`), Board (keyed ids, FLIP param is 0 above 50 cards), CommentThread (`data-saved` set from the action result), UpdateBanner (not animated on mount).

### 13.4 Playwright

- Keep the default `reducedMotion: 'reduce'` for every existing project (so layout specs keep their current stability). Add `e2e/motion.spec.ts` that declares `test.use({ reducedMotion: 'reduce' })` for the "nothing moves" half (B-AC11) and `test.use({ reducedMotion: 'no-preference' })` for the "it moves, and the layout holds" half (B-AC4/B-AC8/B-AC15/B-AC16). A `motion` project in `playwright.config.ts` runs only `motion.spec.ts` plus `shell` and `board-overflow` at 402x874.
- "Nothing moves" probe: a helper that, after each action, returns `document.getAnimations().filter(a => keyframes include transform/translate/scale)` and expects `[]`.
- "No JS": `test.use({ javaScriptEnabled: false })` for the More sheet (B-AC6).
- CSP listener (B-AC12): `page.on('console')` and an injected `securitypolicyviolation` listener.
- The machine is shared: the motion project is opt-in (`--project=motion`) and not part of the default local run; CI runs it once.

## 14. Owner decisions

Answer once, before the build. Proposed defaults in bold.

| # | Decision | Options | Default | Answer |
| --- | --- | --- | --- | --- |
| O1 | Page transitions | Off / phones only / all screens | **Phones only** (under 768 px, incl. installed app); desktop switches pages instantly | default (owner 2026-10-26) |
| O2 | Page transition engine | View Transitions API / Web Animations fade on `<main>` | **View Transitions API**, with the WAAPI fade as an automatic fallback if the dropped-tap test (B-AC4) fails | default (owner 2026-10-26) |
| O3 | Intensity | Subtle / Standard / Lively | **Subtle**: 8 px distances, 200 ms, scale 0.96 to 1, no bounce or spring anywhere | default (owner 2026-10-26) |
| O4 | Token change: 100/150 ms to 120/200 ms for the existing hover and overlay transitions | Yes / keep 100/150 and add the new tokens only | **Yes**, one scale for everything (the difference is barely visible) | default (owner 2026-10-26) |
| O5 | A user-facing "Reduce animations" switch in Account | No (follow the OS only) / Yes | **No.** The OS setting is respected; a switch needs a stored per-user value (migration), not in this pass | default (owner 2026-10-26) |
| O6 | Board cross-column card travel (crossfade) | Yes / fade only | **Yes**, capped at 50 cards; above that the card just appears | default (owner 2026-10-26) |
| O7 | "Saved" highlight and success tick | Both / highlight only / none | **Both**, 1200 ms | default (owner 2026-10-26) |
| O8 | Skeleton shimmer | Yes / static bars | **Yes** (where skeletons exist), under reduce static | default (owner 2026-10-26) |
| O9 | Desktop extras (dialog scale, menu fade, hover lift) | Dialog + menu only / plus hover lift / none | **Dialog and menu only**; no hover lift | default (owner 2026-10-26) |
| O10 | Ship in 0.5.0 with Part A or as a separate PR | Same PR #18 / follow-up | **Same release 0.5.0**; commits separate from Part A so it can be reverted alone | default (owner 2026-10-26) |

## 15. Out of scope / later

- Haptics, sound, confetti, mascots, Lottie, any animation library or new dependency.
- Direction-aware (forward/back) page slides, swipe-back gesture, shared-element transitions between a list row and its detail page.
- Pull-to-refresh animation (Part A O4: no gesture).
- A per-user "Reduce animations" setting (O5).
- Charts or number count-up animations (Ruby has no counting hero numbers; insights charts are static).
- Animation of the Markdown editor, file upload progress or the KB tree.
- Loading skeletons for pages that have none today.
- Parallax, scroll-linked effects, `scroll-driven animations`.

## 16. Release note draft

> **Smoother Ruby.** Sheets, menus and dialogs now slide and fade in, cards glide to their new place on the board, and new comments and saved rows are easy to spot.
> On phones, moving between pages fades. If you turn on "Reduce Motion" on your device, Ruby shows none of it.
