# RB-20 QA report, cycle 2 (fix commit 85b71e2 + motion commit 6df3c29, tip 61ef9bc)

**Verdict: PASS** (no Critical/High/Medium defects; 3 Low/Info notes below). B-AC20 is [P] (real devices) and stays open for the owner.

## Commands run (real local build and local Playwright server; RUBY_TEST_WORKERS=2 RUBY_E2E_WORKERS=1 RUBY_E2E_PORT=4601)
- `npm ci --prefer-offline --no-audit --no-fund` and `npx svelte-kit sync`: ok.
- `npm run gates`: exit 0; svelte-check clean (fail-on-warnings), tsc workers + service worker clean, Vitest 95 files / 1815 tests passed, production build + service worker build ok.
- `npm run test:e2e`: exit 0; 347 passed, 182 skipped (motion.spec is skipped by design in every project except `motion`), 0 failed, 3.8 min.

## Re-check of cycle 1 findings
- **L1 (redirect during install): FIXED.** `precache()` (src/service-worker/index.ts) fetches each shell path with `redirect: 'error', cache: 'reload'` and stores only if `isPrecacheable` (ok && type basic && !redirected, src/lib/shared/sw-policy.ts:22). A redirect or non-200 throws, so install fails and the old worker stays. Evidence: unit `isPrecacheable` (6 cases), source-scan tests (test/pwa.test.ts:271, test/security/rb20-pure.test.ts:145), e2e `rb20-sec` "fixed (L1)" (same-origin 302 on /offline.css: worker never activates, no html under a shell path, css absent, then installs normally) and "cross-origin redirect (Access login)" (nothing stored). Both pass.
- **L2 (lost-answer wording): FIXED.** offline-guard.ts: never-sent keeps `OFFLINE_FORM_MESSAGE` ("Nothing was saved"), lost answer uses `CONNECTION_LOST_MESSAGE` ("may have been saved ... check before trying again"). Unit tests in offline-guard.test.ts and e2e `rb20-sec` "fixed (L2)" pass. The old "Nothing was saved" wording can no longer appear for a lost answer.
- **I1 (re-precache after SIGNED_OUT): OK.** The handler deletes all caches, then `precache()` with the same static list (build files, manifest, icons, offline page, Geist), same redirect/200 checks, errors swallowed. `shellPaths` excludes data paths, `/api /files /hr /people`, and all html but /offline.html. e2e "after many authenticated pages Cache Storage holds no page, data or user-specific URL; sign-out wipes it" and "Safari-like (Clear-Site-Data ignored)" pass: no user email in any cached body, nothing of A left when B signs in. Sender still checked by `isTrustedSender`.

## Motion acceptance criteria (B-AC1 to B-AC20)
Motion e2e ran in project `motion` (Chromium, 402x874, reducedMotion no-preference; the reduce half sets `emulateMedia`), 10/10 pass, plus `shell` and `board-overflow` in that project pass.
| AC | Result | Evidence |
|---|---|---|
| 1 | PASS | test/motion-css.test.ts "motion tokens (B-AC1)" |
| 2 | PASS | motion-css.test.ts: tokens only, no layout props, no `all`, no will-change, loops only shimmer/spinner |
| 3 | PASS | motion-css.test.ts "nothing moves unless ..." ; view-transition rules under no-preference only (src/app.css:539-570) |
| 4 | PASS (Chromium only) | motion.spec.ts:95 fast second tap not lost, nav < 600 ms; WebKit not run (no WebKit project) so unverified there |
| 5 | PASS | `pageTransitionAllowed` unit tests (motion.test.ts); spec:113 no transition on query-only, 1280 px or reduce; /login and /logout excluded in motion.ts; skips on pointerdown (layout) |
| 6 | PASS | spec:139 with JS disabled; sheet rules are plain CSS `.more[open] .sheet` + @starting-style |
| 7 | PASS | spec:184 phone sheet uses transform, reduce does not; focus inside and returns to opener; Escape closes. Desktop scale 0.96 is CSS only (not driven in e2e, see N2) |
| 8 | PASS | spec:217 keyboard move runs FLIP, focus kept, data-saved; none under reduce. Cap: `flipAllowed` count <= 50 (motion.test.ts, `flip` keyed by attribute so it works across columns). Mouse drag and the phone Move form share `flip`; not each driven in e2e |
| 9 | PASS | spec:244 clean load 0 animations; posted comment rises + data-saved |
| 10 | PASS (unit only) | Toaster `out:leave\|local`, max 3, polite live region in motion-render.test.ts; no e2e of the exit animation |
| 11 | PASS | spec:311 and per-spec `moving()` checks: no transform/translate/scale animation under reduce on load, nav, More, dialog, board, comment, calendar |
| 12 | PASS | `securitypolicyviolation` listener + console check in every motion spec (`expectNoCsp`); no changes to _headers/hooks CSP; motion code writes no `style` (rendered-markup tests; Svelte transitions use Web Animations/CSSOM) |
| 13 | PASS (CSS only) | app.css:613-641: shimmer only in `.skeleton[aria-busy='true']`, 200 ms delay, inside no-preference |
| 14 | PASS | spec:275 clean load no banner animation; offline notice slides in |
| 15 | PASS | spec:290 one step animation, from the side, none under reduce |
| 16 | PASS with gap | all existing specs unchanged and pass at default reduce; shell + board-overflow also pass in `motion` at 402 only. Motion project is not run at 360 or 1280 (AC text asks 360/402/1280); static layout specs pass at 360/402/440 under reduce |
| 17 | PARTIAL | test/css.test.ts safe-area rules pass; dialog sheet keeps `--sai-*` padding; no frame-sampled standalone bounds test found |
| 18 | PASS | package.json and THIRD_PARTY_NOTICES.md untouched by the motion commit |
| 19 | PASS | motion-render.test.ts (Dialog, Toaster, Button); no style attribute rendered. Board/CommentThread/UpdateBanner render parity not separately tested |
| 20 | OPEN [P] | real iPhone / Android check by the owner |

## Other checks
- Dialog/DropdownMenu: Dialog Escape and focus return verified (spec:184). DropdownMenu only gained a CSS opacity/translate transition on `.menu:not([hidden])`; its JS is unchanged and existing e2e that use menus pass.
- No horizontal scroll or layout shift: board-overflow + shell pass at 402 (motion) and 360/402/440 (reduce); translate animations are transform-only.
- Back/forward: no custom history code; `onNavigate` only awaits `navigation.complete` and resolves before the callback body, so popstate navigations are not blocked (not driven by a dedicated back/forward test, see N1).
- Security: CSP/headers unchanged. HR reveal: the motion commit touches no HR/people route or reveal component, nothing animates a sensitive value early. View-transition snapshots are in-memory same-session and never run to or from /login or /logout. The `$app/navigation` mock in test/security/rb09-xss.test.ts is `{ afterNavigate: () => {} }`: it only stubs a client-only hook the calendar page now imports; render, sanitizer and assertions are untouched, so the XSS test is not weakened.

## Defects
None at Medium or above.
- **N1 (Low, test gap)** e2e/motion.spec.ts: no explicit back/forward test during a view transition (AC wording "break back/forward"). Repro: phone, tap tab A to B, press back inside 200 ms; expect URL and content of A. Code path looks safe; not verified.
- **N2 (Low, test gap)** B-AC4/B-AC16/B-AC17: Chromium only (no WebKit), motion project only at 402 (not 360/1280), no standalone frame-sampling test. Desktop dialog scale, DropdownMenu motion, toast exit and 51-card cap are covered by unit/CSS tests but not driven in a browser.
- **N3 (Info)** src/service-worker/index.ts `precache()`: not atomic. If one file fails, files already `put` stay in the cache named for that build (the install fails, the old worker stays; the partial cache is removed at the next activation). Static files only, no privacy impact; after SIGNED_OUT a partial failure can leave an incomplete offline shell until next load.
