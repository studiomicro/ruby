# RB-20 mobile PWA: security report

Red-team review of `git diff main..HEAD` (RB-20 tip `cecac2f`, "wip(rb-20-mobile-pwa): cycle 1"), run on 2026-10-26 in
`ruby-worktrees/rb-20-sec`. No product code was changed.

## Verdict: PASS

There are no high or medium findings. Two low findings and two informational notes follow. They are tracked here and
do not block.

The service worker is a read-only shell. The only write to Cache Storage is the install `cache.addAll`. Page loads
always go to the network. `__data.json`, `/api/*`, `/files/*`, `/hr/*`, `/people/*`, `/logout`, non-GET, Range,
query-string and cross-origin requests are never answered from the cache. Testing showed that nothing user-specific
can enter Cache Storage, through any route or URL variant.

## Findings

### L1 (low): the precache keeps a redirected answer under a shell path

- **Where:** `src/service-worker/index.ts:43` (`await cache.addAll(SHELL)`). `fromShell` and `navigate` serve that
  entry later (`:69-83`).
- **Scenario:** during install, one shell file is answered by a same-origin redirect that ends in a 200. Possible
  causes are an Access re-auth hop on the app host, a proxy, or a later change of `assets.html_handling`. `addAll`
  follows the redirect and stores the final body under the original path. In the proof, the sign-in page's HTML is
  stored as `/offline.css`, and it is served cache-first for the rest of that build, after the network is healthy again.
  - If the poisoned path is a `/_app/immutable/*.js` chunk, the app breaks until the next deploy. `nosniff` blocks the
    HTML that is served as a script.
  - If the poisoned path is `/offline.html`, the offline fallback fails, because a redirected response cannot answer a
    navigation.
  - No data leaks: only a signed-out, same-origin page can be stored this way. A cross-origin redirect (the Access
    login) makes the install fail cleanly; this is proven too.
- **Repro:** `e2e/rb20-sec.spec.ts`, test "LOW finding: the precache stores a redirected answer…". It routes
  `**/offline.css` to `302 /login` during install, then reads the `text/html` entry from the cache.
- **Fix:** replace `addAll` with a fetch per path, using `{ redirect: 'error', cache: 'reload' }` or a check of
  `response.redirected || !response.ok || response.type !== 'basic'`. Then `cache.put` only those answers. This keeps
  the single-write-site rule and fails the install on any redirect.

### L2 (low): "Nothing was saved" is shown for a save that did reach the server

- **Where:** `src/lib/ui/pwa/offline-guard.ts:47` (`isOfflineResult` gives the offline note),
  `src/lib/ui/pwa/network-error.ts:10`, and `src/hooks.client.ts:10`.
- **Scenario:** the connection drops after the server applied a form action but before the answer arrives. The browser
  raises the same `TypeError: Failed to fetch` as for a request that never left. The form then says "You are offline.
  Nothing was saved." (`offline-guard.ts:14`), but the write is in D1. The person tries again, which can create a
  duplicate comment, task, time-off request or event.
- **Checklist:** this goes against "Truthful state" in `docs/ENGINEERING_CHECKLIST.md`.
- **Repro:** `e2e/rb20-sec.spec.ts`, test "LOW finding: a save that reached the server but lost its answer…". It uses
  `route.fetch()` then `route.abort()` on `/account?/name`. The note says nothing was saved, and the reload shows the
  new name.
- **Fix:** keep the definite text only for the pre-send case (`navigator.onLine === false`, request cancelled). For a
  mid-flight network error, use wording such as "The connection dropped. Your change may not have been saved. Check
  before trying again." Optionally, make creating actions idempotent with a per-form nonce.

### I1 (info): after a Safari sign-out, the active worker has no offline page until the next deploy

- **Where:** `src/service-worker/index.ts:55` and `:82-83`.
- **Detail:** `SIGNED_OUT` deletes every cache, including the active build's own cache. In Safari, `Clear-Site-Data` is
  ignored, so the worker stays registered with an empty cache. Offline page loads then get `Response.error()` (the
  browser's own error) and shell files come from the network.
- **Impact:** not a leak. It only costs the offline page.
- **Option:** after the wipe, re-run the shell precache, or unregister the worker so the next page registers a fresh one.

### I2 (info): a sign-out sent while offline wipes the cache, but the session stays valid

- **Where:** `src/routes/(app)/+layout.svelte:169` and `:257` (`onsubmit={signalSignedOut}`).
- **Detail:** the wipe message is posted before the POST is sent. If the POST fails (offline, aborted), the server
  session is not revoked, and the browser shows its own offline error. On a shared device, the next person who goes
  online is still signed in as the last person.
- **Context:** before RB-20 the session also stayed valid, but now nothing in the app says so.
- **Repro:** `e2e/rb20-sec.spec.ts`, test "INFO: a sign-out sent offline…".
- **Option:** while `connection.online` is false, make the sign-out button say "Can't sign out while offline", or show
  it disabled with that reason.

## Checked and holding

| Area | Result |
| --- | --- |
| Cache contents | Signed in, the test browsed `/people`, `/people/org`, `/hr/audit`, `/calendar`, `/notifications`, `/my-tasks`, `/kb`, `/search`, `/account`, `/admin/users` and `/time-off`. It fetched `__data.json`, `/api/mentions`, `/files`, `/files/<id>`, `/hr/export`, `/HR/export`, `//files/…`, `/files%2F…`, `/./people/x`, `/_app/immutable/%2e%2e/%2e%2e/people`, `manifest.webmanifest?u=1`, HEAD, Range and `version.json`. The cache key set stayed identical; no entry has a query string; no cached body holds a seed e-mail address. 26 hostile request variants never get `shell` (unit test). |
| Precache list | The real `static/` list plus build files gives no HTML except `/offline.html`, no data path, no `/splash/`, `/screenshots/` or other font, and no hidden or server file. Hostile names (`index.html`, `files/*`, `__data.json`, `version.json`) are filtered out. |
| Deploy that removes files | Each build has its own versioned cache. Stale caches are deleted on activate. The old worker serves only its own hashed chunks, and new HTML always comes from the network. |
| Access interplay | An Access cross-origin redirect is passed through for a page load and is never replaced (QA AC10). During install it fails the install: nothing is stored and the worker does not activate. The manifest is same-origin with `crossorigin="use-credentials"`; neither it nor `/service-worker.js` sends `Access-Control-Allow-Origin`. |
| Handshake | Messages count only from a same-origin window. Rejected senders: another origin, a look-alike origin, http, `about:srcdoc`, `data:`, a worker, a shared worker, no source, a garbage URL. 200 `SKIP_WAITING` messages with no waiting worker caused no controller change; look-alike `SIGNED_OUT` shapes are ignored. A cross-origin frame cannot reach this origin's worker. |
| Sign-out, two people | With `Clear-Site-Data` stripped (Safari-like), `SIGNED_OUT` emptied Cache Storage. After A signed out and B signed in, no A data was in localStorage, sessionStorage, IndexedDB (none exist) or the cache, and no-store pages re-fetch as B. Without JS, `Clear-Site-Data: "cache", "storage"` does the wipe; the cache holds no user data either way. |
| Offline page | The SW-served answer for any non-data path keeps `script-src 'none'`, `frame-ancestors 'none'`, `connect-src 'none'`, `form-action 'none'` and `X-Frame-Options: DENY`. It has no script, inline style, form or external URL, and does not reflect the requested URL (an `<script>` query was tested). |
| Headers, `html_handling: "none"` | `/service-worker.js` is `no-cache`, JavaScript, with no `Service-Worker-Allowed`; its scope is `/`. These paths do not answer 200 and leak nothing: `/_worker.js`, `/_headers`, `/_routes.json`, `/_redirects`, `/.assetsignore`, `/index.html`, `/login.html`, `/_app/`, `/_app/immutable/`, `/fonts/`, `/icons/`, `/offline.html/`, `/offline`. There is no directory listing. The build has no prerendered HTML to shadow, and `/login` still comes from the Worker with its CSP. |
| CSP | `manifest-src 'self'` and `worker-src 'self'` only narrow the policy. `script-src` has no `unsafe-inline` or `unsafe-eval`; `frame-ancestors 'none'`. Static SVGs hold no script. |
| Manifest and UI | `start_url`, `scope`, `id`, shortcuts and images are all same-origin relative paths. There are no `share_target`, `protocol_handlers`, `file_handlers` or `related_applications`. No new `{@html}`. The offline note uses `textContent`. The standalone back control (`parentHref`) encodes each parameter as one segment; `//`, `..`, `\` and CRLF values stay on this origin. |
| Offline form wrapper | Offline, the submit is cancelled before the page callback runs; nothing is stored, scheduled or replayed (no timers, no storage). A 403 CSRF or 500 answer is not turned into the offline note. A cross-site POST to `/account?/name` is still 403. All forms import the wrapper, none `$app/forms` `enhance`. |

## Commands run

| Command | Result |
| --- | --- |
| `npm ci --prefer-offline --no-audit --no-fund && npx svelte-kit sync` | done |
| `npm run build` | `✔ done` |
| `RUBY_TEST_WORKERS=2 npx vitest run test/security/rb20-pure.test.ts` | `Tests 53 passed (53)` |
| `RUBY_E2E_PORT=4561 RUBY_E2E_WORKERS=1 npx playwright test e2e/rb20-sec.spec.ts --project=desktop` | `11 passed (43.3s)` (the first run had 1 failure, a test bug: `/people/*` is not intercepted by design; the path was fixed) |
| `npx eslint test/security/rb20-pure.test.ts e2e/rb20-sec.spec.ts` (after `prettier --write` on both files) | exit 0 |
| `RUBY_TEST_WORKERS=2 RUBY_E2E_WORKERS=1 npm test` | exit 0, `Test Files 92 passed (92)`, `Tests 1794 passed (1794)` |

## Not tested

- Real Safari/WebKit: Safari was simulated by removing `Clear-Site-Data`. A real iOS standalone install was not used.
- A real Cloudflare Access edge: the Access redirects were emulated with Playwright routes.
- The other e2e projects (iphone-*, phone-360): the proofs run on desktop Chromium only.
