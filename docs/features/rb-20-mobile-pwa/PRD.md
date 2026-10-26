# RB-20 Mobile and PWA

> Make Ruby installable on iOS and Android, with a branded launch, a safe read-only offline page and a service worker that never keeps one person's data
> where the next person on the same phone could see it.

## Summary

| Field | Value |
| --- | --- |
| ID | RB-20 (proposed here; the request gave no ID) |
| Status | Approved (owner decisions answered 2026-10-26) |
| Risk tier | **Medium** by default. **Large** if the owner turns Web Push on (O6). See [Risk tier](#risk-tier) |
| Release version | **0.5.0** (owner answer O13: RB-20 ships next; later features take the following versions). Release note `src/lib/content/releases/0.5.0.md` |
| Migration | **None in the default build.** Only if O6 = yes: `0017_push_subscriptions.sql` |
| Depends on | Hard: RB-00 shell and the phone layout (`CLAUDE.md:74-77`), RB-11. Soft: RB-12, RB-09 (see [Dependencies](#dependencies)) |
| Owner | Owner (request by the owner) |
| Date | 2026-10-26 |

Request: owner, 2026-10-26, "create new feature for mobile and PWA support". RB-20 is proposed here (no ID was given).

### Risk tier

**Medium**: a new service worker and manifest that interact with the locked CSP, Cloudflare Access and the sign-out wipe. No auth, session or schema
change in the default build.

If the owner turns Web Push on (O6) the tier becomes **Large** (new table, secrets, a send path in `ruby-jobs`). The push part is then built as a second
pass after the first ships.

Pipeline: engineer + QA + red team (the service worker is a shared-device data-leak surface).

### Dependencies

- **RB-00** shell and the phone layout from the 2026-10-26 request (`CLAUDE.md:74-77`).
- **RB-11**: update banner, `/_app/version.json`, release notes.
- **Soft, RB-12**: the "Report an issue" shortcut, route `/issues/new`. If RB-12 is not merged the shortcut is left out of the manifest, never a dead link.
- **Soft, RB-09**: `ruby-jobs` Worker and the `reminder` notification kind, only for push.

### Version and migration notes

- `package.json`, `package-lock.json` and `APP_VERSION` in `wrangler.jsonc` and `workers/jobs/wrangler.jsonc` are set to 0.5.0 so the RB-11 deploy guard passes.
- Migration `0017` only if O6 = yes. 0013 is RB-16, 0014 RB-17, 0015 RB-18, 0016 RB-19 (taken). Confirm 0017 is free at merge.

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

Ruby is used all day from phones (the layout work already exists) but it is still a browser tab:

- no home-screen icon,
- no standalone window,
- a blank error page when the signal drops,
- an update banner that only knows about server deploys.

This increment makes Ruby installable on iOS and Android. It gives Ruby a branded launch, a safe offline fallback, and a service worker that makes
loading faster without ever keeping one person's data where the next person on the same phone could see it.

Its design: a read-only offline shell, no write queue, versioned shell cache, SKIP_WAITING handshake, pure `sw-policy`
module. It is adapted to Ruby's rules: an internal HR-adjacent app behind Cloudflare Access, English only, Ruby branding only.

## 2. Scope

**In**

1. Icon set, self-generated from `static/favicon.svg` ([4.7](#47-icon-set)).
2. Web app manifest, static file, with shortcuts and screenshots ([4.8](#48-web-app-manifest)).
3. iOS specifics: status bar style and launch images ([4.9](#49-ios-specifics)).
4. Service worker with the pure `sw-policy` and `sw-update` modules ([4.10](#410-service-worker)).
5. Update flow integrated with RB-11, one banner for two signals ([4.11](#411-update-flow-integrated-with-rb-11)).
6. Install UX: "Install Ruby" row, never a nag ([4.12](#412-install-ux)).
7. Mobile polish: Refresh action, overscroll, standalone back control, input zoom, landscape safe areas, offline indicator, offline forms
   ([4.13](#413-mobile-polish)).
8. Web Push, default **OFF** (owner decision O6): design recorded, built only if O6 = yes ([4.14](#414-web-push-default-off)).

**Out**

- Offline write queue, background sync, offline reading of pages or data, IndexedDB mirrors, runtime caching of any response.
- Web Push in the default build (design only until O6).
- Haptics, native share target, file handling, badging, contact picker, geolocation, camera.
- A custom pull-to-refresh gesture; a native app store wrapper (TWA/Capacitor).
- iPad launch images and iPad-specific layout (unless O9).
- Dark-mode-specific manifest icons; per-user themed icons.
- E-mail notifications (RB-09 decision).
- Changing the Access policy.

## 3. Current behaviour this builds on

Cite before changing.

- **`src/app.html:5-16`**
  - `viewport-fit=cover`, `color-scheme`, `robots noindex`, `apple-mobile-web-app-title` "Ruby".
  - Light and dark `theme-color` (`#fbfbfb`, `#030303`).
  - Favicon `static/favicon.svg` (ruby-red `#b4233c` rounded tile with a white gem).
  - No manifest link, no apple-touch-icon, no status-bar meta, no service worker. `static/` holds only `favicon.svg` and `fonts/`.
- **Safe areas**
  - `--sai-top/right/bottom/left` from `env(safe-area-inset-*)` (`src/app.css:35-42`).
  - Components never use `env()` directly (`test/css.test.ts`).
  - Scroll padding for the top bar and tab bar at `app.css:245-246`.
  - Phone tab bar below 768 px, More sheet, `nav.ts` (`TAB_ITEMS`, `FOOTER_ITEMS`, `moreItems()`), 44 px targets, inputs >= 16 px.
  - Playwright spec `e2e/shell.spec.ts` at 402x874, 440x956, 360.
- **CSP**: `src/lib/server/csp.ts:11-24`
  - `default-src 'self'`, `script-src 'self'`, `worker-src 'self'`, `connect-src 'self'`; `img-src 'self'`.
  - No `manifest-src`, so it falls back to `default-src 'self'`.
  - Applied by SvelteKit (`vite.config.ts:12`, `mode: 'auto'`) to rendered pages only; static files get only `_headers`.
- **`_headers`** (repo root) has one rule: `/_app/version.json` is `Cache-Control: no-store`.
- **RB-11**
  - `version.pollInterval` 60 s (`vite.config.ts:14`).
  - `src/lib/ui/shell/UpdateBanner.svelte`: `updated.current`, Reload with the dirty-form dialog, sits above the tab bar at z-index 25.
- **`src/hooks.server.ts:76-77`**: every signed-in, auth and >= 400 response is `private, no-store`.
  Sign-out sets `clear-site-data: "cache", "storage"` (`hooks.server.ts:13`).
  `"storage"` unregisters service workers and clears Cache Storage, IndexedDB and localStorage for the origin.
  This is the sign-out wipe the SW design relies on and must not weaken.
- **Cloudflare Access** sits in front of the whole host (`hooks.server.ts:56-62`; `ACCESS_DISABLED=1` is an owner switch).
  An expired Access session answers with a cross-origin redirect to the Access login, not a Ruby page.
- **Downloads**: `/files/[id]` (RB-04) and `/hr/export` (RB-05) send private data; `CLAUDE.md:104-105`.

## 4. Design

CTO calls in 4.1 to 4.6 (D1 to D6); the owner can override them under [Owner decisions](#14-owner-decisions). Sections 4.7 to 4.14 are the build scope.

### 4.1 D1. Read-only offline shell, no write queue

A read-only offline shell. The service worker stores only the build's own files and a few static assets, plus one offline page.

It stores no page HTML, no `__data.json`, no `/api/*`, no `/files/*`. Offline, Ruby shows a clear "You are offline" page and reads nothing stale.

Reason: every Ruby page is the viewer's private work (and HR data). A shared-device cache of rendered pages is the exact leak the `no-store` headers
exist to prevent.

> [!NOTE]
> An **offline write queue is OUT of scope** (O2). Queued writes need conflict handling against the `updated_at` "changed meanwhile" rule, per-user queue
> wipe on sign-out, and idempotency keys on every action. That is a separate large feature.

### 4.2 D2. Network-first navigation, shell cache-first

| Policy | Behaviour | Applies to |
| --- | --- | --- |
| `shell` | Cache-first, from the versioned cache | Build files (`$app/service-worker` `build`) and `static` `files` that are safe |
| `navigate` | Network: `fetch` with the original request; offline page only when the fetch itself throws | Every same-origin navigation |
| `network` | Not intercepted | Everything else: non-GET, `__data.json`, `/api/*`, `/files/*`, `/hr/*`, `/logout`, `/_app/version.json`, range requests, cross-origin |

- For `navigate`: a response that is not `ok`, a redirect, or an opaque response (Access login) is passed through untouched.
- The offline page is shown only for a thrown network error, never for a 401/403/5xx or an Access redirect.
- Fail-safe: any unknown request is `network`. A policy test asserts that no authenticated path can ever map to `shell`.

### 4.3 D3. Where the logic lives

- Pure module `src/lib/shared/sw-policy.ts`, unit-tested. Exports: `OFFLINE_PAGE`, `shellPaths(build, files)`, `requestPolicy(request, origin, shellSet)`,
  `cacheName(version)`, `isStaleCache(name, current)`.
- `src/service-worker/index.ts` is a thin wiring file using `$app/service-worker`.
- Update handshake in `src/lib/shared/sw-update.ts`: `isSkipWaitingMessage`, `skipWaitingOnInstall(hasActive)`.
  First install activates at once; an update waits for the user.
- Page side in `src/lib/ui/pwa/register.svelte.ts`.

### 4.4 D4. Registration and CSP

- SvelteKit's automatic registration is turned off (`kit.serviceWorker.register: false`).
- Registration is explicit from bundled code so the waiting state is observable:
  `navigator.serviceWorker.register('/service-worker.js', { scope: '/' })`, `!dev`, feature-detected.
- In both cases: no inline script (`script-src 'self'` unchanged), `worker-src 'self'` already present, `connect-src 'self'` covers the SW's own fetches.
- `manifest-src` falls back to `default-src 'self'`. Add an explicit `'manifest-src': ['self']` for clarity (test in `csp.test`).
- No `'unsafe-inline'` anywhere.
- Web Push (O6) needs no CSP change (push is delivered to the SW, which is `'self'`).

### 4.5 D5. Cloudflare Access and the manifest

The manifest link must be:

```html
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />
```

A credential-less manifest fetch would be redirected by Access and break installability. Verify on staging with the real Access app.

- `/service-worker.js` and icons are fetched same-origin with credentials by the browser.
- Neither may require a signed-in Ruby user (static files); Access still gates them.
- If Access cannot be satisfied for the manifest in some browsers, installability degrades to "Add to Home Screen" only. This is documented in the runbook,
  not worked around by exempting paths from Access. Exempting paths is an owner decision (O8).

### 4.6 D6. Static files and the offline page

`static/offline.html` is plain HTML. An inline `<style>` is allowed only if `_headers` serves it with a matching CSP, because the page is served from Cache
Storage and from the assets binding outside SvelteKit's CSP pipeline.

Chosen design: **external stylesheet `/offline.css` and no script at all**. "Try again" is a plain link to `/` (a full navigation).

- English text: "You are offline. Ruby needs a connection to show your work. Check your signal and try again."
- Ruby text only, in English.
- Uses Geist (precached) and the app's light and dark tokens via `prefers-color-scheme`.
- Safe-area padding via `env()` is acceptable here only because this static file is outside the `--sai-*` rule.
  The CSS test scope is `src/`. The engineer confirms `test/css.test.ts` does not scan `static/`; otherwise define the `--sai-*` variables at the top of
  `offline.css`.

### 4.7 Icon set

Self-generated from `static/favicon.svg` (the ruby-red mark) by `scripts/generate-icons.ts`.

- Run by hand, committed outputs, never part of `gates` or `build` (like `scripts/generate-splash-screens.ts`).

| File | Purpose / size |
| --- | --- |
| `static/icons/icon-192.png`, `icon-512.png` | purpose `any` |
| `static/icons/icon-maskable-192.png`, `icon-maskable-512.png` | mark inside the 80 % safe zone on a full-bleed `#b4233c` background |
| `static/icons/icon-monochrome-512.png` | white mark on transparent |
| `static/icons/apple-touch-icon.png` | 180x180, opaque, no transparency, no rounded corners (iOS rounds it) |
| `static/icons/shortcut-*.png` | 96x96 |
| `static/icons/icon.svg` | for browsers that take SVG |

- Rendering: Chromium via the Playwright dependency already in the repo, re-encoded as small PNGs. The same script prints a table the tests read.
- No third-party image tool added. If Playwright cannot be used offline, the engineer uses `sharp` as a **devDependency only** and says so.

### 4.8 Web app manifest

Served as a static file `static/manifest.webmanifest` (Ruby has no per-plan icons, so no dynamic manifest route), with
`Content-Type: application/manifest+json` via `_headers`.

| Member | Value |
| --- | --- |
| `name`, `short_name` | "Ruby" |
| `description` | "Projects, tasks and the knowledge base for your team." |
| `lang`, `dir` | "en", "ltr" |
| `id`, `start_url`, `scope` | "/" |
| `display` | "standalone" |
| `display_override` | ["standalone", "minimal-ui"] |
| `orientation` | "any" (landscape allowed; see O11) |
| `categories` | ["productivity", "business"] |
| `prefer_related_applications` | false |
| `background_color`, `theme_color` | `#fbfbfb` / `#fbfbfb` (light values; see note) |
| `icons` | the five above: any 192/512, maskable 192/512, monochrome 512 |

> [!NOTE]
> The manifest holds one colour value each, so it uses the **light** values. Dark mode is handled per page by the existing
> `<meta name="theme-color" media=...>` pair (`app.html:11-12`), which browsers prefer over the manifest, and by the splash images on iOS.
> A comment in the PR notes this. Do not add non-standard manifest members.

**Shortcuts** (max 4, Android long-press and desktop):

| Shortcut | URL | Condition |
| --- | --- | --- |
| New task | `/my-tasks?new=1` | Only if that deep link exists; otherwise `/projects`. The engineer picks the nearest existing route and cites it |
| My tasks | `/my-tasks` | Always |
| Search | `/search` | Always |
| Report an issue | `/issues/new` | Only when RB-12 is merged |

- Every shortcut URL is inside `scope` and is an existing route (a test checks each against the route tree).
- Shortcuts open the sign-in page when signed out, then return (existing `next` handling).

**Screenshots**

- 2 narrow (`form_factor` "narrow", 1080x1920-class, home and a task list on the seeded demo data, light) and 1 wide (`form_factor` "wide", 1280x720),
  in `static/screenshots/`.
- Taken by `scripts/capture-screenshots.ts` from the **seed data only** (fictional, `docs/ACCEPTANCE.md` seed rule); never real data.
- They are network-only (not precached) and optional for installability.

**`app.html` additions**

- Manifest link (4.5).
- `<link rel="apple-touch-icon" href="%sveltekit.assets%/icons/apple-touch-icon.png">`.
- `<meta name="mobile-web-app-capable" content="yes">`.
- `<meta name="apple-mobile-web-app-capable" content="yes">` (kept for iOS < 16.4).
- `apple-mobile-web-app-status-bar-style`, and the splash links (4.9).
- The existing `apple-mobile-web-app-title` stays.

### 4.9 iOS specifics

**Status bar style: `default`.**

- With `viewport-fit=cover` and `black-translucent`, the page would draw under the status bar and the top bar would need extra padding.
- Ruby's top bar already pads by `--sai-top`, but `default` keeps the status bar an opaque system strip matching `theme-color`. No layout change at all and
  zero risk of text under the clock.
- The owner may choose `black-translucent` (O5). The acceptance test for standalone layout must then show no clipped top bar at 402x874.
- Default stays `default`.

**Launch images**

- `scripts/generate-splash-screens.ts`: mark centred on `--bg`, `#fbfbfb` light and `#030303` dark, to match `app.css` tokens.
- It writes `static/splash/splash-<w>x<h>-<light|dark>.png` and `src/lib/shared/splash-screens.ts` (the table the layout and tests read).

Device table (portrait, CSS points, scale to pixels):

| CSS points @ scale | Pixels | Devices |
| --- | --- | --- |
| 402x874 @3 | 1206x2622 | iPhone 16 Pro, 17, 17 Pro, 18 Pro |
| 440x956 @3 | 1320x2868 | 16 Pro Max, 17 Pro Max |
| 393x852 @3 | 1179x2556 | 15, 15 Pro, 16 |
| 430x932 @3 | 1290x2796 | 15 Plus, 15 Pro Max, 16 Plus |
| 390x844 @3 | 1170x2532 | 12, 13, 14 |
| 428x926 @3 | 1284x2778 | 12/13/14 Plus, Pro Max |
| 375x812 @3 | 1125x2436 | X, XS, 11 Pro |
| 414x896 @3 and @2 | (both scales) | XS Max, 11 Pro Max, XR, 11 |
| 375x667 @2 | | SE |
| small iPad set | | only if the owner asks (O9, default: no iPad) |

- Each device gets a light and a dark link:
  `<link rel="apple-touch-startup-image" media="(device-width: Wpx) and (device-height: Hpx) and (-webkit-device-pixel-ratio: S) and (orientation: portrait) and (prefers-color-scheme: ...)">`.
- Links are rendered by `src/routes/+layout.svelte` via `<svelte:head>` from the table (no inline script).
- The sizes are re-verified against Apple's HIG / iosref at build time (state the source and date in the script header).
- Splash files are `network`-only in the SW (iOS asks for them itself) and cached by the HTTP cache.
  `_headers` `max-age=31536000, immutable` is allowed because file names change with content only if renamed; use a short `max-age=86400` instead to stay safe.
- Approximate cost: 14 images x 2 themes, indexed PNG a few KB each.

### 4.10 Service worker

Files: `src/service-worker/index.ts`, `src/lib/shared/sw-policy.ts`, `src/lib/shared/sw-update.ts`.

**install**

- Open cache `ruby-shell-<version>` (`version` from `$app/service-worker`, the build id; the same id SvelteKit's `_app/version.json` carries).
- `addAll(shellPaths(build, files))`: the build's immutable JS/CSS, `offline.html`, `offline.css`, `icons/*` (small ones), `manifest.webmanifest`,
  `favicon.svg`, the Geist variable font only.
- Excluded: `splash/`, `screenshots/`, other fonts, anything matching a data path.
- First install `skipWaiting()`s; an update waits.

**message `{ type: 'SKIP_WAITING' }`**: calls `skipWaiting()`. The sender must be a same-origin client (`event.source` is a `WindowClient` of this origin)
or the message is ignored.

**activate**: delete every cache whose name is not the current shell cache (including any future name prefix of other versions), `clients.claim()`.

**fetch**: per 4.2.

> [!WARNING]
> Never `cache.put` for runtime responses. The only writes to Cache Storage are the install-time precache. This makes "never cache authenticated HTML or
> data in a shared way" structurally true: there is no runtime-cache code path to get wrong.

**sign-out**

- `Clear-Site-Data: "cache", "storage"` (already set) removes registrations, caches and storage.
- Additionally the SW answers a `{ type: 'SIGNED_OUT' }` message by deleting all caches (belt and braces for browsers where `Clear-Site-Data` `"storage"`
  is not honoured, notably Safari: Clear-Site-Data is unsupported in Safari). The logout form's client enhancement posts that message after the
  2xx/redirect.
- **Because Safari ignores `Clear-Site-Data`, the shell cache must not contain anything user-specific by construction.** It does not: build files and
  static only. The acceptance test asserts the precache list contains no path outside `build` + `files`.

**Navigation preload**: off (no benefit, adds a request path to reason about).

### 4.11 Update flow integrated with RB-11

Two signals, one banner. `updated.current` (SvelteKit poll) stays the source for "a new deploy exists".

New: `src/lib/ui/pwa/register.svelte.ts` exposes `waiting: boolean` (a `registration.waiting` exists, or `updatefound` to installed with an active
controller).

- `UpdateBanner.svelte` shows when `updated.current || pwa.waiting`.
- **Reload**: if `pwa.waiting`, post `SKIP_WAITING`, wait for `controllerchange` (once, with a 3 s timeout), then `location.reload()`. Otherwise today's
  behaviour.
- The dirty-form confirm dialog and the `beforeNavigate` guard are unchanged and run first.
- The page calls `registration.update()` on `visibilitychange` to visible (at most once per 5 minutes), so a standalone app resumed from the background
  notices a deploy without waiting for the 60 s poll in a frozen tab.
- `/_app/version.json` keeps its `no-store` `_headers` rule and is never intercepted by the SW (`network`).
- Banner copy unchanged ("A new version of Ruby is available."); the release note says what is new.

### 4.12 Install UX

Files: `src/lib/ui/pwa/install.svelte.ts`, `InstallEntry.svelte`.

**Detection**: `standalone` = `matchMedia('(display-mode: standalone)')` or `navigator.standalone === true`. Already installed: the entry is hidden (or
shows "Ruby is installed" in Account, no button).

**Where**

- An **"Install Ruby"** row on `/account` (section "App") and in the phone **More sheet** (above "What's new"), both added through `nav.ts`-style data,
  not scattered.
- Hidden on desktop widths only if the browser offers no install path and not iOS.
- Never in the tab bar, never a banner, never a toast, never a modal on load.

**Per platform**

| Platform | Behaviour |
| --- | --- |
| Chromium (Android, desktop) | Capture `beforeinstallprompt` (preventDefault, keep the event). The row calls `prompt()` only on the user's tap. Outcome `dismissed` hides the row's button for 30 days (`localStorage` key `ruby.install.dismissed`, try/catch, per-viewer convenience). `appinstalled` hides it |
| iOS Safari (and iPadOS) | No event exists. The row opens an in-app `<dialog>` with plain steps (below), with a small inline SVG of the share glyph (no remote image). Detection is feature-based first (`'standalone' in navigator`, no `beforeinstallprompt`); user-agent sniffing only to choose the wording (iOS Safari vs in-app browser) |
| iOS non-Safari in-app browsers (Instagram, LinkedIn, Gmail webviews) | The dialog says "Open this page in Safari to install Ruby." plus a Copy link button |

iOS dialog steps:

1. Tap the Share button in Safari's toolbar.
2. Scroll and tap "Add to Home Screen".
3. Tap "Add".

Never nags: no automatic prompt, no recurring reminder, no count-based re-ask. The row is passive. All strings English.

### 4.13 Mobile polish

**Pull to refresh**

- Native pull-to-refresh exists in mobile Chrome tabs but **not in an installed iOS PWA**, and is disabled when `overscroll-behavior-y: contain/none`
  is set.
- Decision: keep `overscroll-behavior-y: none` on `html`/`body` in standalone only (`@media (display-mode: standalone)`). This stops rubber-banding of the
  whole shell and accidental refreshes inside nested scrollers.
- Add a **visible Refresh affordance** instead of a gesture hack: a **Refresh** action in the More sheet and the Account "App" section. It calls
  `invalidateAll()` (soft data reload, keeps form state) and shows "Updated just now".
- A custom pull gesture is out (O4 to change). In browser tabs nothing changes (native behaviour stays).

**`overscroll-behavior`**

- `contain` on the More sheet, dialogs, the board's horizontal scroller and any inner scroll container, so scrolling them never scrolls the page behind.
- `none` on the root in standalone.
- A Playwright check reads the computed values.

**Standalone back navigation**

- A standalone window has no browser back button.
- Rule: every non-root `(app)` page that is not a tab destination gets a visible back control in the phone top bar in standalone mode (and only there).
- It uses `history.back()` when the previous entry is same-origin (tracked via a session counter from `afterNavigate`, never `document.referrer`).
  Otherwise it navigates to the page's parent route, from a small route-parent table next to `nav.ts`
  (for example `/projects/[key]/tasks/[n]` to `/projects/[key]`, `/kb/[slug]` to `/kb`).
- 44 px target. iOS edge-swipe back keeps working (do not intercept `popstate`). Browser tabs unchanged.

**Input zoom**

- Already >= 16 px.
- Add a CSS test that no `input, select, textarea` rule under 768 px resolves below 16 px (extends the existing guard).
- Add a test that `maximum-scale`/`user-scalable=no` is absent from `app.html` (zoom stays available).

**Landscape safe areas**

- Left/right insets matter on phones in landscape (Dynamic Island on the side).
- Verify every fixed element (top bar, tab bar, sidebar-as-tab-bar, update banner, offline banner, More sheet, dialogs, toasts) pads by
  `--sai-left/right` in landscape at 874x402, 956x440 and 640x360. Fix the ones that do not.
- Playwright adds those three landscape viewports (with an emulated inset).
- Layout does not switch to the sidebar below 768 px width, so 874 and 956 wide landscape phones become the **desktop sidebar layout** (width >= 768).
  Confirm the sidebar pads by `--sai-left` and content by `--sai-right`.

**Offline indicator**

- `src/lib/ui/pwa/online.svelte.ts` (`navigator.onLine`, `online`/`offline` events).
- When offline: a slim non-blocking banner "You are offline. Changes can't be saved." (`role="status"`), above the tab bar, honouring `--sai-*`, under the
  update banner (z-index 24). It hides on `online`.
- `navigator.onLine` is a hint: a failed `fetch` in an enhanced form also sets the state to offline until the next success.

**Forms offline**

- Every SvelteKit form uses `use:enhance`. A shared wrapper `src/lib/ui/pwa/offline-form.ts` handles a thrown network error.
- The form stays filled, an inline error under the form says "You are offline. Nothing was saved. Try again when you are back online.", and the submit
  button re-enables.
- A submit made while `navigator.onLine === false` is not sent at all and shows the same message.
- Without JS, the browser's own failure applies and `navigate` falls back to the offline page.
- **Nothing is queued, stored, retried or replayed.** Success is still shown only after the server confirms (`CLAUDE.md:82`).

**Not in this pass**

- Haptics: out of scope.
- Native share target, badging (`navigator.setAppBadge`) and file handling: out of scope (O10 lists the badge as a possible follow-up tied to unread
  notifications).

### 4.14 Web Push (default OFF)

Owner decision O6. With O6 = no the build contains: no `push` handler, no `Notification.requestPermission` call anywhere, no subscription UI, no VAPID
variable, no table. Only this design is recorded. With O6 = yes (second pass):

**Prerequisites**

- Worker secret `VAPID_PRIVATE_KEY` (base64url PKCS8 or raw 32-byte scalar).
- Vars `VAPID_PUBLIC_KEY` (base64url, public, served to the client) and `VAPID_SUBJECT` (`mailto:` of the owner, from `docs/RUNBOOK.md`).
- `ruby-jobs` (RB-09) needs the same secret binding.
- Missing: the Push section on `/account` shows "Push notifications are not set up", no table writes, no send.

**Migration `0017_push_subscriptions.sql`**: see [section 6](#6-data-and-migrations).

- Cap 10 per user.
- `endpoint`, `p256dh` and `auth` are secrets-grade: never serialised into page data, never logged (the request-log line already omits bodies and
  queries).
- Rows are hard-deleted (no personal history value). This is an exception to soft delete because a subscription is a revocable credential, same rule as
  sessions.

**Routes**

- `POST /api/push/subscribe` and `POST /api/push/unsubscribe` behind `requireUser` + the CSRF check.
- The endpoint must be `https:` and its host on an allow-list of push services (`fcm.googleapis.com`, `*.push.services.mozilla.com`,
  `web.push.apple.com`, `*.notify.windows.com`), otherwise 400 (SSRF guard, since `ruby-jobs` will POST to it).

**Triggers and delivery**

- Only the two kinds already in the in-app inbox that are time-sensitive: RB-09 `reminder` and RB-03 `mention`. Assigned and comment stay in-app only (O7).
- Delivery is a step of the RB-09 dispatch in `ruby-jobs` after the `notifications` row is inserted. Push failure never blocks or rolls back the in-app
  notification.
- Payload is encrypted (RFC 8291 aes128gcm, WebCrypto in the Worker). It **contains no task content beyond a short title the recipient may already see**
  (<= 100 chars, summary snapshot) and a same-origin `url`. TTL 1 day, urgency `normal`.
- HTTP 404/410 from the push service deletes the subscription; 5 consecutive failures do too.

**Sign-out and deactivation**

- The logout action first calls `unsubscribe` for this browser's endpoint: delete the row, then `pushManager.getSubscription().unsubscribe()`.
- The logout form posts this browser's endpoint and the server deletes `WHERE user_id = ? AND endpoint = ?`.
- Deactivating a user (admin) deletes all their subscriptions in the same `db.batch`.

**SW handlers**

- `push`: parse defensively, `showNotification` with the Ruby icon and `data.url`. If the payload is invalid, show a generic "Ruby" notification rather than
  nothing, as iOS may revoke permission after silent pushes.
- `notificationclick`: same-origin `url` only, focus an existing window, else `openWindow`.
- Notification text never includes HR fields.

**Platform support to state in the UI**

- Android and desktop Chromium/Firefox: works in the browser and installed.
- **iOS and iPadOS 16.4+: only when Ruby is installed to the Home Screen (standalone).** The Push section on iOS Safari in a tab shows "Install Ruby to the
  Home Screen first" and a link to the install steps.
- Permission is requested only on a tap on "Turn on notifications" (never on load). A denied permission shows how to re-enable in system settings.
- Per-user per-device opt-in; a per-kind toggle (reminders, mentions) on `/account`.

### 4.15 Architecture notes

**New**

- `src/service-worker/index.ts` (+ its own `tsconfig.json` extending `$app/tsconfig/service-worker`), `src/lib/shared/sw-policy.ts`, `sw-update.ts` (+ tests).
- `src/lib/ui/pwa/{register,install,online}.svelte.ts`, `InstallEntry.svelte`, `OfflineBanner.svelte`, `offline-form.ts`.
- Route-parent table beside `nav.ts`.
- `static/{manifest.webmanifest,offline.html,offline.css,icons/*,splash/*,screenshots/*}`.
- `scripts/{generate-icons,generate-splash-screens,capture-screenshots}.ts`, `src/lib/shared/splash-screens.ts`.

**Touched**

- `src/app.html`, `src/routes/+layout.svelte` (splash links, registration), `src/routes/(app)/+layout.svelte` (offline banner, back control, standalone CSS).
- `src/lib/ui/shell/UpdateBanner.svelte` (waiting-worker path), `src/lib/ui/shell/nav.ts` (More entry), `src/routes/(app)/account/+page.svelte` ("App" section).
- `src/lib/server/csp.ts` (`manifest-src`), `_headers` (manifest type, `/service-worker.js` no-cache, `/offline.html`, `/icons/*`, `/splash/*`).
- `src/app.css` (overscroll, standalone rules), `e2e/` (new `pwa.spec.ts`, landscape cases in `shell.spec.ts`).
- `docs/RUNBOOK.md`, `docs/ACCEPTANCE.md`, `docs/TASKS.md`, release note and version files.

**Reuse**: `--sai-*`, `dirty-forms.ts`, `hasDirtyForm`, `Button`, `<dialog>` pattern from `UpdateBanner`, the logout form, `CLEAR_SITE_DATA`,
`invalidateAll`. No new runtime dependency (devDependency only if icon rendering needs it).

**Build**

- SvelteKit emits `service-worker.js` at the root from `src/service-worker`; the Cloudflare adapter serves it as a static asset.
- The engineer verifies on `wrangler dev` that the file is served with the right type and that `_headers` applies (`_headers` is already honoured,
  `version.json` rule).
- Playwright installability tests run against `vite preview`/`wrangler dev` over `localhost` (a secure context). The service worker does not register under
  `vite dev`.

### 4.16 Prerequisites

- Default build: none. Cloudflare Access must allow the manifest fetch with credentials (verify on staging; fallback O8).
- Push (O6 = yes):
  - `VAPID_PRIVATE_KEY` secret, `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` vars (exact names added to `wrangler.jsonc` and `docs/RUNBOOK.md`, with a
    key-generation command).
  - `ruby-jobs` deployed (RB-09).
  - Migration `0017` applied remotely by the owner.
  - Missing: push UI hidden, no sends, app works.
- The owner applies any remote change; the engineer prepares the runbook steps only.

### 4.17 Tracker impact

- `docs/TASKS.md`: add "RB-20 Mobile and PWA (in build)" under the current increments; no existing item is closed. When shipped, move evidence to
  `docs/HISTORY.md`.
- `docs/ACCEPTANCE.md`: adds rows "Installable PWA", "Offline fallback", "Update flow", "Standalone layout". Rows 1-27 can reach Automated; the real-device
  row stays Mocked until the owner checks it (AC28).
- `docs/ENGINEERING_CHECKLIST.md` items map to:

| Checklist item | Criteria |
| --- | --- |
| Authorization | AC24 |
| States | AC17-19, AC23 |
| No secrets in page data | AC29 (push keys) |
| CSP and headers | AC3, AC16 |
| Version and release note | AC27 |
| `docs/RUNBOOK.md` update | see [4.15](#415-architecture-notes) |

Soft delete, FTS and Markdown rendering are not touched in the default build.

## 5. Routes and UI

No route is added in the default build; the manifest, worker and offline page are static files.

| Route / surface | Who | What |
| --- | --- | --- |
| `/manifest.webmanifest` | anyone past Access (static) | Manifest, `application/manifest+json` |
| `/service-worker.js` | anyone past Access (static) | The only worker, scope `/`, `Cache-Control: no-cache` |
| `/offline.html`, `/offline.css` | anyone past Access (static) | Generic offline page, no script, "Try again" link to `/` |
| `/icons/*`, `/splash/*`, `/screenshots/*` | anyone past Access (static) | Icons (precached, small ones), launch images and screenshots (network-only) |
| `/account` (section "App") | member, admin | "Install Ruby" row, Refresh action; push section only if O6 = yes |
| Phone More sheet | member, admin | "Install Ruby" row (above "What's new"), Refresh action |
| Phone top bar, standalone only | member, admin | Back control on non-root, non-tab `(app)` pages |
| Banner area | member, admin | Update banner (z-index 25), offline banner (z-index 24) |
| Manifest shortcuts | member, admin | `/my-tasks?new=1` or `/projects`, `/my-tasks`, `/search`, `/issues/new` (RB-12 only) |
| `POST /api/push/subscribe`, `/api/push/unsubscribe` | member, admin (O6 = yes only) | Subscribe or remove this browser's push subscription |

## 6. Data and migrations

| Table | Change | Notes |
| --- | --- | --- |
| none | **No schema change in the default build** | |
| `push_subscriptions` | Add, only if O6 = yes (`0017_push_subscriptions.sql`) | Unique `(endpoint)`, index `(user_id)`, hard delete, cap 10 per user |

```sql
-- migrations/0017_push_subscriptions.sql (only if O6 = yes; confirm 0017 is free at merge)
-- push_subscriptions (id, user_id FK users, endpoint text NOT NULL, p256dh text NOT NULL, auth text NOT NULL,
--   user_agent_label text, created_at, updated_at, last_success_at, failure_count int NOT NULL DEFAULT 0)
-- unique (endpoint); index (user_id)
```

> [!NOTE]
> The engineer writes the real statements to match the house style of `migrations/`. The column list above is the contract. Hard delete is an exception to
> soft delete (see [4.14](#414-web-push-default-off)).

## 7. Limits

| Limit | Value | Where enforced |
| --- | --- | --- |
| Shell cache size | <= 3 MB total (only Geist Variable font, no other fonts) | `manifest.test.ts`; fails above, so first install stays fast (AC25) |
| Splash files and screenshots | Never precached | `shellPaths` filter, `sw-policy.test.ts` (AC25) |
| Shortcuts | <= 4 | `manifest.test.ts` (AC2) |
| Install dismissal memory | 30 days | `install.svelte.ts`, `install.test.ts` (AC17) |
| `registration.update()` | At most once per 5 min per page | `register.svelte.ts`, `register.test.ts` |
| `controllerchange` wait on Reload | 3 s timeout | `register.svelte.ts`, `register.test.ts` |
| Push subscriptions (if on) | <= 10 per user | subscribe route (AC29) |
| Push payload (if on) | <= 1 KB | send path (AC29) |
| Push send batch (if on) | 50 per dispatch tick | RB-09 dispatch in `ruby-jobs` |

## 8. Authorization

No route is added in the default build; `requireUser`/`requireAdmin` stay unchanged on every load, action and download.

| Action | Signed-out | Member | Admin | HR / other |
| --- | --- | --- | --- | --- |
| Fetch manifest, SW, icons, offline page (static, nothing private; still behind Access) | allowed | allowed | allowed | n/a |
| Use install row, Refresh action | n/a (under `(app)`) | allowed | allowed | n/a |
| `/files/*`, `/hr/*` (a SW-controlled page changes nothing) | refused | as before | as before | HR rules as before |
| `POST /api/push/subscribe`, `/unsubscribe` (O6 = yes) | refused | allowed (own subscriptions) | allowed (own) | deactivated user refused |
| Delete all of a user's push subscriptions (O6 = yes) | n/a | n/a | on deactivating that user | n/a |

## 9. Concurrency and failure states

| Situation | Behaviour |
| --- | --- |
| Network drops during a navigation | Offline page from the SW, HTTP 200, "Try again" link; never for 401/403/5xx or a redirect |
| Access session expired | Cross-origin redirect to the Access login passes through untouched; never masked by the offline page |
| Form submitted offline | Input kept, inline error, button re-enabled, no request, nothing queued; one manual re-submit creates exactly one row |
| Dirty form when the update Reload is pressed | Existing confirm dialog first; nothing reloads until "Reload anyway" |
| `controllerchange` does not arrive | Reload proceeds after the 3 s timeout |
| Safari ignores `Clear-Site-Data` | `SIGNED_OUT` message deletes all caches; the shell cache holds nothing user-specific anyway |
| Access blocks the manifest fetch in some browsers | Installability degrades to "Add to Home Screen" only; runbook note; decide O8 again |
| `localStorage` unavailable | try/catch; the install row still works, only the 30-day memory is lost |
| VAPID config missing (O6 = yes) | Push UI hidden or "not set up", no table writes, no sends; app works |
| Push send fails (O6 = yes) | The in-app notification is intact; 404/410 or 5 consecutive failures delete the subscription |

## 10. Mobile and accessibility

- **Viewports**: 402x874, 440x956, 360x800 (portrait); 874x402, 956x440, 640x360 (landscape, emulated 59 px left/right insets).
- **Safe areas** are read only through `--sai-*`. `offline.css` is the one documented exception. See 4.6.
- **No horizontal page scroll**; zoom stays available (no `maximum-scale`, no `user-scalable=no`).
- **44 px targets** (install row, Refresh, back control); inputs >= 16 px under 768 px.
- **Overscroll**: `none` on the root in standalone, `contain` on More sheet, dialogs, board scroller.
- **Banners**: offline banner `role="status"`, no overlap with tab bar, update banner or home indicator.
- **Install dialog** is a native `<dialog>` with plain steps; the iOS steps carry an inline SVG share glyph.
- **Standalone back control** keeps iOS edge-swipe back working (no `popstate` interception).
- **Dark mode**: tokens via `prefers-color-scheme`; splash and `theme-color` metas have light and dark variants.
- **Real-device check** is manual, AC28.

## 11. Security and privacy

- **Scope**: `/service-worker.js` is served from `/`, so its scope is the whole origin. It is the only worker; the manifest `scope` is `/`.
  Served `Cache-Control: no-cache` (set in `_headers`: `/service-worker.js`) so a bad worker can be replaced at once. `Service-Worker-Allowed` not needed.
- **No runtime cache.** Cache Storage is written only at install from `build` + `files`. A test greps the SW source for `cache.put`/`cache.add(`/
  `cache.addAll` outside the install handler and fails.
- **Never intercepted or cached**: `/files/*`, `/hr/*`, `/people/*`, `/api/*`, `/logout`, `*/__data.json`, `/_app/version.json`, all non-GET, `Range`
  requests, responses with `Cache-Control: no-store`, any cross-origin request, any response that is a redirect or opaque.
- **Cache keys**: exact URL path of build/static files under cache `ruby-shell-<version>`. `Vary` is ignored by design (no per-user content). Query
  strings on shell files are ignored only for `/offline.html`.
- **Sign-out wipes**: `Clear-Site-Data "cache","storage"` (unchanged; test that `/logout` still sets it) plus the `SIGNED_OUT` message for Safari.
  Per-user `localStorage` items (install dismissal) hold no user data. Push subscriptions are deleted as described in 4.14.
- **Shared device**: the offline page is generic; it shows no name, no project, no data. The SW holds no session cookie.
- **Access**: an Access redirect during a navigation is never masked by the offline page (4.2).
- **Push abuse**: endpoint allow-list, auth keys never leave the server, payload encrypted per RFC 8291. VAPID key rotation is documented: rotating
  invalidates all subscriptions; they are deleted and users re-opt-in.
- **Manifest** reveals nothing private; `robots noindex` stays.
- **CSP** unchanged except `manifest-src 'self'`; no new origins.
- **Logging**: never log page text, comment text, attachment names or HR values; push `endpoint`, `p256dh` and `auth` are never logged.
- **Screenshots** come from seed data only, never real data.

## 12. Acceptance criteria

Verification levels per `docs/ACCEPTANCE.md`: [A] Automated (Vitest/Playwright), [M] Mocked, [P] Pass (manual on a real device).

- [ ] AC1 [A] `GET /manifest.webmanifest` returns 200, `application/manifest+json`, valid JSON with `name` "Ruby", `short_name`, `id`, `start_url` "/",
  `scope` "/", `display` "standalone", and icons for 192 and 512 `any`, 192 and 512 `maskable`, 512 `monochrome`. Every `src` exists under `static/` and its
  pixel size equals `sizes` (test reads the PNG header).
- [ ] AC2 [A] Every shortcut URL is a real route inside scope; the "Report an issue" shortcut exists only when `/issues/new` exists; at most 4 shortcuts.
- [ ] AC3 [A] `app.html` has the manifest link with `crossorigin="use-credentials"`, apple-touch-icon, `apple-mobile-web-app-status-bar-style` =
  `default`, both `theme-color` metas unchanged, no `maximum-scale` or `user-scalable`.
- [ ] AC4 [A] `apple-touch-icon.png` is 180x180 and has no alpha channel; maskable icons keep the mark inside the 80 % safe circle (pixel check on the
  corners and centre).
- [ ] AC5 [A] The splash table includes 402x874@3 (1206x2622) and 440x956@3 (1320x2868), light and dark. Every
  `<link rel="apple-touch-startup-image">` media query matches a file that exists with the right pixel size; images are non-empty indexed PNGs.
- [ ] AC6 [A] Chromium installability: with the production build served over `localhost`, the page has a manifest, a registered and activated service worker
  controlling the page, and Playwright's CDP `Page.getInstallabilityErrors` returns none.
- [ ] AC7 [A] First visit registers the SW; after activation the shell cache `ruby-shell-<version>` holds the offline page, the Geist font and the build's
  JS/CSS and holds **no** HTML page of the app, no `__data.json`, no `/api/`, `/files/`, `/hr/` or `/people/` URL.
- [ ] AC8 [A] `requestPolicy` table test:
  - build file maps to `shell`; `/offline.html` maps to `shell`;
  - navigation (GET, `mode: navigate`, same-origin) maps to `navigate`;
  - `POST` anything, `__data.json`, `/api/x`, `/files/1`, `/hr/export`, `/logout`, `/_app/version.json`, cross-origin, Range request, unknown path,
    `/splash/*`, `/screenshots/*` map to `network`;
  - no path under an authenticated prefix maps to `shell`.
- [ ] AC9 [A] Offline fallback: after the SW controls the page, `context.setOffline(true)`; navigating to `/projects` shows the offline page (title
  "Offline", text "You are offline"), HTTP 200 from the SW, with a working "Try again" link; back online the same link loads the real page.
- [ ] AC10 [A] A navigation that gets a 403, 500 or a cross-origin redirect (simulated by route-fulfilling) is **not** replaced by the offline page.
- [ ] AC11 [A] Signed-in HTML is never served from cache: sign in as user A, load `/my-tasks`, go offline, reload: the offline page shows, not A's page.
  Sign out, sign in as user B: no content of A appears at any point (including with the network blocked right after sign-out).
- [ ] AC12 [A] After sign-out the response to `POST /logout` carries `clear-site-data` containing `"cache"` and `"storage"` (existing test stays green), and
  after the Playwright run `caches.keys()` is empty and `navigator.serviceWorker.getRegistration()` is undefined in Chromium. The `SIGNED_OUT` message path
  deletes caches when exercised directly [A, unit with a fake `caches`].
- [ ] AC13 [A] Update: a second build (different `version`) deployed to the preview server, then the open page gets `updated.current` or a waiting worker,
  then the banner shows. Reload with a clean form posts `SKIP_WAITING`, the new worker takes control, the page reloads, and `caches.keys()` contains only the
  new version's cache. With a dirty form, Reload shows the existing confirm dialog first and nothing reloads until "Reload anyway".
- [ ] AC14 [A] `/_app/version.json` still answers `Cache-Control: no-store` (existing `_headers` rule unchanged, test reads the file) and is `network` in the
  policy.
- [ ] AC15 [A] `SKIP_WAITING` from a non-window or other-origin source is ignored; first install skips waiting, an update with an active worker does not
  (`skipWaitingOnInstall`).
- [ ] AC16 [A] CSP: the document response still has no `unsafe-inline` in `script-src`, `worker-src 'self'`, `manifest-src 'self'`.
  `src/service-worker/index.ts` and the pages contain no inline script. The browser console shows no CSP violation during install, update and offline in
  Playwright.
- [ ] AC17 [A] Install UX:
  - with `beforeinstallprompt` simulated, the "Install Ruby" row appears on `/account` and in the More sheet;
  - tapping calls `prompt()` exactly once per tap, never before a tap (no call on load, none after navigation);
  - "dismissed" hides the button and writes the 30-day key; `appinstalled` and `display-mode: standalone` hide the row;
  - with an iOS Safari user agent and `navigator.standalone` false, the row opens the three-step dialog; in an in-app browser UA it shows the "Open in Safari"
    text;
  - no banner, toast or modal appears on load in any case.
- [ ] AC18 [A] Offline indicator: going offline shows the banner within 1 s, hides on reconnect, does not overlap the tab bar, the update banner or the home
  indicator at 402x874, 440x956, 360x800.
- [ ] AC19 [A] A form action submitted offline keeps its input, shows "You are offline. Nothing was saved. Try again when you are back online.", re-enables
  the submit button, performs no request, and after reconnecting a second manual submit succeeds exactly once (no duplicate row). No
  `IndexedDB`/`localStorage`/Cache entry is created for the payload.
- [ ] AC20 [A] Standalone layout (Playwright with `display-mode: standalone` emulated through a launch arg/`page.emulateMedia` where supported, and CSS
  checked via the `@media (display-mode: standalone)` rule): at 402x874, 440x956 and 360x800 no horizontal page scroll, top bar and tab bar clear the
  emulated insets, root `overscroll-behavior-y` is `none`, the More sheet and dialogs are `contain`, inputs >= 16 px.
- [ ] AC21 [A] Landscape at 874x402, 956x440, 640x360 with emulated 59 px left/right insets (via the `--sai-*` override the existing spec uses): no fixed
  element is clipped by the insets; no horizontal scroll.
- [ ] AC22 [A] Standalone back control: shown on `/projects/[key]/tasks/[n]` and `/kb/[slug]` in standalone only; goes to the in-app previous page when there
  is one, else the parent route; absent on the four tab destinations and in a normal tab.
- [ ] AC23 [A] Refresh action in the More sheet and Account calls `invalidateAll` once, shows a saving state and a success or error result, and keeps
  unsaved form input.
- [ ] AC24 [A] `requireUser`/`requireAdmin` unchanged on every load/action/download (no route is added in the default build). Signed-out and deactivated
  requests to `/files/*`, `/hr/*` are still refused and a SW-controlled page does not change that. The static files (manifest, SW, icons, offline page) are
  fetchable signed-out (they contain nothing private) and still sit behind Access.
- [ ] AC25 [A] Shell cache size <= 3 MB; precache list has no `splash/`, `screenshots/` or non-Geist fonts.
- [ ] AC26 [A] CSS guard (`test/css.test.ts`) still passes: no component uses `env(safe-area-inset-*)` directly; `offline.css` is the documented exception.
- [ ] AC27 [A] `package.json`, `APP_VERSION` and `src/lib/content/releases/0.5.0.md` agree at 0.5.0 (RB-11 test). The note is plain English, says how to
  install, mentions the offline page, and states that nothing is saved offline.
- [ ] AC28 [M] Installability on a real Android Chrome and a real iPhone (Add to Home Screen, standalone launch, splash shown, status bar legible, no content
  under the Dynamic Island in portrait and landscape, back control works, update banner appears after a staging deploy and Reload applies it) is recorded as
  [P] by the owner or QA with device names and iOS/Android versions. Never reported as passed without it.
- [ ] AC29 If O6 = yes (second pass), additionally:
  - [A] subscribe/unsubscribe refused signed-out and for a deactivated user;
  - [A] a foreign `endpoint` host is 400; subscriptions cap at 10; logout and deactivation delete rows;
  - [A] 410 from a mocked push service deletes the row;
  - [A] push is sent for `mention` and `reminder` only;
  - [A] payload decrypts with the test key and holds no HR field;
  - [A] a push failure leaves the in-app notification intact;
  - [A] missing VAPID config disables the UI and sends nothing;
  - [A] migration `0017` test over 0000..0017 seeded data (row counts of existing tables unchanged, `PRAGMA foreign_key_check` empty);
  - [M] real-device delivery on Android, desktop and an installed iPhone (iOS 16.4+).

## 13. Test plan

| Layer | File | Covers |
| --- | --- | --- |
| Vitest unit | `sw-policy.test.ts` | AC8 table, plus fuzz of paths (any path containing `/api/`, `__data.json`, `/files/`, `/hr/` is never `shell`), `shellPaths` filter, `cacheName`/`isStaleCache` |
| Vitest unit | `sw-update.test.ts` | AC13, AC15 |
| Vitest unit | `register.test.ts` | Waiting detection, `controllerchange` timeout |
| Vitest unit | `install.test.ts` | Prompt capture, 30-day dismissal with a throwing `localStorage`, standalone detection, iOS vs in-app UA wording (AC17) |
| Vitest unit | `online.test.ts` | Offline indicator state (AC18) |
| Vitest unit | `offline-form.test.ts` | No request when offline; message; no storage writes (AC19) |
| Vitest unit | `manifest.test.ts` | AC1-AC4 and AC25 |
| Vitest unit | `splash-screens.test.ts` | AC5 |
| Vitest unit | `csp.test.ts` | `manifest-src` (AC16) |
| Vitest unit | release-version guard | AC27 |
| Vitest unit | route-parent table test | AC22 |
| Vitest unit | source-scan test | The SW has no runtime `cache.put` |
| Vitest integration (local D1) | push tests | AC29, only if push is on |
| Playwright (`npm run test:e2e`, outside `gates`, production build) | `e2e/pwa.spec.ts` | AC6, AC7, AC9-AC14, AC16, AC17-AC19 at 402x874, 440x956, 360x800; standalone-emulated and landscape runs (AC20-AC23); two-user sign-out check (AC11, AC12); update flow using two builds served in turn (AC13). Clipboard and `beforeinstallprompt` are simulated by dispatching a synthetic event from the test |
| Manual [P] | n/a | AC28 on one Android and one iPhone (402x874 class and 440x956 class), recorded with exit codes of the automated runs and the device notes |
| Regression | RB-11 update banner tests, the shell spec, `css.test.ts`, headers tests | All unchanged and green; `npm run gates` must pass |

> [!NOTE]
> The Lighthouse PWA audit is not a gate (the category was removed); installability is the CDP check (AC6).

## 14. Owner decisions

Answer once, before the build. Proposed defaults in bold.

| # | Decision | Options | Default | Answer |
| --- | --- | --- | --- | --- |
| O1 | Ship the PWA at all (manifest, service worker, install UX) as a read-only offline shell | Yes / No | **Yes.** | default (owner 2026-10-26) |
| O2 | Offline write queue (queue edits offline, sync later) | Out of scope / Build it | **OUT of scope.** Forms that fail offline say so and nothing is queued. A queue needs conflict, idempotency and sign-out wipe rules; separate feature if wanted | default (owner 2026-10-26) |
| O3 | Offline reading of previously viewed pages | Yes / No | **No.** Pages hold private work and HR data; only the shell and a generic offline page are cached | default (owner 2026-10-26) |
| O4 | Pull-to-refresh | Gesture / Refresh action | **No gesture;** a "Refresh" action in More and Account, and `overscroll-behavior` set so nothing refreshes by accident | default (owner 2026-10-26) |
| O5 | iOS status bar style | `default` / `black-translucent` | **`default`** (opaque system bar, no layout risk). `black-translucent` is possible after a standalone layout review | default (owner 2026-10-26) |
| O6 | Web Push | Off / On | **OFF.** Design recorded; build later behind `VAPID_*` secrets and migration `0017`. If ON: reminders and mentions only, iOS 16.4+ standalone only | default (owner 2026-10-26) |
| O7 | If push is ON, which kinds | Reminders and mentions / add assigned and comment | **Reminders and mentions.** Assigned and comment stay in-app | default (owner 2026-10-26) |
| O8 | If Access blocks the manifest fetch, exempt `/manifest.webmanifest`, `/service-worker.js` and `/icons/*` from Access | Exempt / No exemption | **No exemption;** use `crossorigin="use-credentials"`. Decide again only if staging shows installability fails | default (owner 2026-10-26) |
| O9 | iPad launch images and layout | iPhone only / add iPad | **No.** iPhone only, as in the 2026-10-26 layout request | default (owner 2026-10-26) |
| O10 | App badge (unread count on the home-screen icon) | Now / Later | **Later,** with push; not in this pass | default (owner 2026-10-26) |
| O11 | Manifest `orientation` | `any` / portrait only | **`any`** (landscape allowed, safe areas verified) | default (owner 2026-10-26) |
| O12 | Store listing screenshots in the manifest | Yes / No | **Yes,** 2 narrow + 1 wide from seed data only | default (owner 2026-10-26) |
| O13 | Version number | next free version / later | next free version | **0.5.0** — RB-20 ships next (owner 2026-10-26); later features take the following versions |

## 15. Out of scope / later

- Offline write queue, background sync, offline reading of pages or data, IndexedDB mirrors, runtime caching of any response (see O2, O3).
- Web Push in the default build: design only until O6 = yes; then a second pass after the first ships.
- App badge (`navigator.setAppBadge`): later, with push (O10).
- Haptics, native share target, file handling, contact picker, geolocation, camera.
- A custom pull-to-refresh gesture (O4); a native app store wrapper (TWA/Capacitor).
- iPad launch images and iPad-specific layout (O9).
- Dark-mode-specific manifest icons; per-user themed icons.
- E-mail notifications (RB-09 decision).
- Changing the Access policy (O8 if staging forces it).

## 16. Release note draft

> **Ruby 0.5.0: install Ruby on your phone**
>
> You can now add Ruby to your home screen and open it like an app. On iPhone, tap Share in Safari, then "Add to Home Screen", then "Add". On Android and
> desktop Chrome, use "Install Ruby" in Account or in the More menu.
>
> If your signal drops, Ruby shows a clear "You are offline" page instead of a blank screen. Nothing is saved while you are offline, so try again when
> you are back online. When a new version is ready, the update banner works in the installed app too.
>
> Signing out clears everything Ruby stored on your phone.
