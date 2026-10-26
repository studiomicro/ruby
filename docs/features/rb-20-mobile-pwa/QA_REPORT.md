# RB-20 Mobile and PWA: QA report

**Verdict: PASS** (automated criteria). AC28 (real iPhone/Android) is NOT verified and stays [M] Mocked until the owner or QA checks a device. Two low documentation defects are open.

## Commands run

- `RUBY_TEST_WORKERS=2 RUBY_E2E_WORKERS=1 npm run gates`: exit 0; svelte-check, lint, Vitest "Test Files 91 passed (91), Tests 1741 passed (1741)", build and adapter done; local Vitest + local D1, no remote service.
- `RUBY_TEST_WORKERS=2 RUBY_E2E_WORKERS=1 RUBY_E2E_PORT=4551 npm run test:e2e`: exit 0; "310 passed, 99 skipped (5.1m)"; production build under local `wrangler dev`, local D1, Chromium. Skips are project-gated tests (`onlyOn`) and 4 pre-existing no-JS/screenshot specs; no failures. This run began before `rb20-qa.spec.ts` existed.
- `RUBY_E2E_PORT=4551 npx playwright test e2e/rb20-qa.spec.ts`: exit 0; "12 passed, 13 skipped (49.5s)" across iphone-402, iphone-440, phone-360 and desktop; `eslint` and `prettier` clean on the file.
- No migration added, so `db:reset:local` not required.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC1 manifest | PASS | rb20-qa "manifest" test: 200, `application/manifest+json`, name/id/start_url/scope/display, 192+512 any, 192+512 maskable, 512 monochrome, every PNG header size equals `sizes` |
| AC2 shortcuts | PASS | 3 shortcuts (<=4) in scope, none 404 signed out, icons load. "New task" goes to `/projects` (accepted deviation). No `/issues/new` shortcut, so rule satisfied |
| AC3 head tags | PASS | pwa.spec AC3/AC5 test; `src/app.html` diff: manifest `crossorigin="use-credentials"`, apple-touch-icon, status bar `default`, theme-color metas kept |
| AC4 touch icon + maskable | PASS | rb20-qa: 180x180, colour type 0/2 (no alpha); maskable 192/512 corners equal, no mark pixel outside the 80 % circle |
| AC5 launch images | PASS | rb20-qa: 402x874 -> 1206x2622 and 440x956 -> 1320x2868, light and dark, media has DPR 3 + portrait, files have exact pixel size. iPhone Air 420x912 present. 360 has none: no iOS 360 pt phone, expected |
| AC6 installable | PASS | pwa.spec Chromium installability test (CDP `getInstallabilityErrors` empty) |
| AC7 shell cache | PASS | rb20-qa dumped caches after 13 authenticated routes plus project/person detail: only `/_app/immutable/*`, favicon, Geist, `/icons/*`, manifest, `offline.css`, `offline.html` |
| AC8 policy | PASS | `sw-policy.test.ts` in gates |
| AC9 offline page | PASS | pwa.spec offline test and rb20-qa offline test at 402/440/360/desktop: `context.setOffline(true)`, 200, title Offline, "Try again" link, no horizontal overflow |
| AC10 403/500/cross-origin | PASS | pwa.spec AC10 test |
| AC11 no signed-in HTML | PASS | pwa.spec; rb20-qa scans cached bodies for the user's e-mail: none |
| AC12 sign-out wipe (relaxed) | PASS | `POST /logout` has `clear-site-data` with "cache" and "storage" (rb20-qa, pwa.spec); `SIGNED_OUT` message empties `caches.keys()`. Strict "caches empty after logout" is relaxed: `/login` re-registers a worker holding only the shell. rb20-qa checks that post-logout cache has no HTML except offline.html |
| AC13 update flow | PASS | pwa.spec update test: waiting worker, UpdateBanner, dirty-form confirm first, "Reload anyway", one reload; releases.spec update banner tests green |
| AC14 version.json | PASS | rb20-qa: `Cache-Control: no-store`; releases.spec "never cached" |
| AC15 SKIP_WAITING trust | PASS | `sw-update.test.ts` in gates |
| AC16 CSP | PASS | pwa.spec (no CSP console violations in install, offline); `csp.test.ts`; offline.html has no `<script` (rb20-qa) |
| AC17 install UX | PASS | pwa.spec: row in Account and More, one `prompt()` per tap, 30-day dismissal, iOS 3-step dialog, in-app browser text, standalone hides. rb20-qa: synthetic `beforeinstallprompt` on 6 routes at 3 widths gives 0 `prompt()` calls, no open dialog, no install status/alert |
| AC18 offline banner | PASS | pwa.spec at 402/440/360 |
| AC19 offline form | PASS | pwa.spec: message "You are offline. Nothing was saved. Try again when you are back online.", input kept, button re-enabled, 0 POSTs, no localStorage/IndexedDB/Cache entry, one save after reconnect |
| AC20 standalone layout | PASS | pwa.spec standalone test; html `data-display=standalone` Chromium fallback is accepted. rb20-qa: no horizontal scroll on `/`, `/account`, `/projects`, `/my-tasks`, `/people`, `/releases`, `/offline.html` at 402, 440, 360 |
| AC21 landscape | PASS | pwa.spec 874x402, 956x440, 640x360 with 59 px insets |
| AC22 back control | PASS | pwa.spec: standalone only, absent on tabs, history else parent; `route-parent.test.ts` |
| AC23 Refresh | PASS | pwa.spec Refresh test keeps typed input |
| AC24 auth unchanged | PASS | no route added; static files fetchable signed out; shortcut routes redirect rather than 404; auth specs in e2e green |
| AC25 cache size/filter | PASS | pwa.spec and `pwa.test.ts`; no `splash/` or `screenshots/` in the dump |
| AC26 CSS guard | PASS | `css.test.ts` in gates |
| AC27 version | PASS with doc defect | `package.json`, `wrangler.jsonc` `APP_VERSION` and `0.5.0.md` agree at 0.5.0 (owner O13). Note covers install steps, offline page, nothing saved offline, privacy. See D1 |
| AC28 real device | NOT RUN | No device available. Remains [M]; do not report as passed |
| AC29 push | N/A | O6 = off |

Other checks: `wrangler.jsonc` `assets.html_handling: "none"` present and `/offline.html` serves 200 in e2e. `_headers` rules cover service-worker, manifest, offline CSP, icons.

## Findings

- **D1 (Low, docs)**: PRD still says 0.10.0 where owner chose 0.5.0: `docs/features/rb-20-mobile-pwa/PRD.md:13`, `:40`, `:755` and the release draft at `:829`. Code uses 0.5.0. Repro: `grep -n 0.10.0 docs/features/rb-20-mobile-pwa/PRD.md`. Fix the PRD text (no code change).
- **D2 (Low, note)**: PRD version table at `PRD.md:13` also lists 0.5.0 as RB-12 and the later versions; stale once RB-20 takes 0.5.0.
- **Observation (no defect)**: a form posted without JavaScript while offline gets the browser's own error page, since the worker never intercepts non-GET. Nothing is saved and nothing is claimed, so it is honest; the friendly message needs JS (`enhance`).
- **Observation**: no iOS launch image for 360 wide (no such iPhone). 
- Engineering checklist: no violation found in the diff.

## Proofs

`e2e/rb20-qa.spec.ts` (untracked, not committed). No product code changed.
