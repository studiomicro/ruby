# RB-00 foundation — Security report (red team)

- Scope: commits `1c91ab3` (foundation) and `ddc68db` (e2e port), whole tree as of `HEAD` (`ddc68db`).
- Brief: CLAUDE.md › Access and auth (there is no RB-00 PRD); checked against `docs/ENGINEERING_CHECKLIST.md`.
- Date: 2026-10-26. Reviewer: red-team-pentester. No product code changed.

## Verdict: FAIL

One Medium finding: admin invites outlive the admin who made them (M1). Everything else is Low or informational.

## Findings

### M1 — Medium: a disabled or demoted admin's pending invites stay valid, including admin invites

- Where: `src/lib/server/auth/users.ts:85-119` (`setUserStatus` revokes the user's sessions but not their invites),
  `src/lib/server/auth/users.ts:122-142` (`setUserRole`, same gap), `src/lib/server/auth/invites.ts:188-237`
  (`acceptInvite` checks that the invite is live, not that its `created_by` is still an active admin).
- Scenario: admin Bob (an insider who is leaving, or an account that has been taken over) creates an invite with role
  `admin` for an address he controls. Ada disables Bob, or demotes him. Bob's sessions end, but the invite he made
  still works for up to 7 days (`INVITE_TTL_MS`). Anyone with the link who gets through Access can accept it and
  becomes an active **admin**. The invite's e-mail is not tied to the Access identity, so that can be any person
  Access lets in. So "disable" does not fully remove an admin's power, which the checklist expects ("a deactivated
  user's sessions are rejected on the next request"). The pending list on `/admin/users` shows these invites, but
  only an admin who checks that list will revoke them.
- Repro: `test/security/rb00-d1.test.ts` › "PROOF M: an admin invite made by an admin who is then disabled still
  creates an admin" and "… after the inviting admin is demoted to member". Both pass, so the weakness is present.
- Fix (both parts):
  1. In `setUserStatus(… 'disabled')`, and in `setUserRole` when it demotes, add to the same `db.batch` a step that
     revokes the target's invites: `UPDATE invites SET revoked_at = ? WHERE created_by = ? AND accepted_at IS NULL
     AND revoked_at IS NULL`, guarded like the session revoke.
  2. In `acceptInvite` statement 1, add the condition `exists (select 1 from users c where c.id = invites.created_by
     and c.role = 'admin' and c.status = 'active')`. Then an invite only admits people while its creator could still
     invite. Add a regression test for both.

### L1 — Low: JWKS fetch has no single-flight and no negative cache

- Where: `src/lib/server/auth/access.ts:130-148`.
- Scenario: when the cache is older than `JWKS_REFETCH_MIN_MS`, N concurrent requests with an unknown `kid` make N
  JWKS fetches. While the JWKS endpoint fails, every request fetches again and can wait up to 5 s
  (`JWKS_TIMEOUT_MS`). Only requests that Access forwarded reach this code, and Access sets the header, so an
  attacker cannot freely choose the `kid`. The risk is availability during a Cloudflare JWKS outage or a cold
  isolate. When the cache is past its TTL and a refresh fails, keys that are still valid are not used either
  (fails closed, which is correct, but it turns a short outage into 503s).
- Repro: `test/security/rb00-pure.test.ts` › "PROOF L: concurrent unknown-kid requests each fetch the JWKS" (26
  fetches for 25 concurrent requests) and "… no negative cache" (10 fetches for 10 requests).
- Fix: keep one in-flight fetch promise per team domain. After a failure, remember it for about 10 s. Optionally,
  accept a stale key set for a bounded grace period when the refresh fails.

### L2 — Low: account lockout can be triggered by anyone, and nothing unlocks it

- Where: `src/lib/server/auth/password.ts:22-23, 155-168`.
- Scenario: five wrong passwords lock any known address for 15 minutes. Repeating that every 15 minutes keeps the
  only admin locked out indefinitely. The attacker must get through Access, and team addresses are known inside the
  team. No admin unlock exists and no "your account was locked" signal is shown. Insider DoS only.
- Repro: `test/security/rb00-d1.test.ts` › "PROOF L: five wrong guesses lock the only admin out".
- Fix: accept as a known risk, or make it harder to abuse. For example, add an admin "unlock" action, raise the
  limit per account, or lock per (account, client) pair, with a higher global cap.

### L3 — Low: the per-IPv4 sign-in budget is shared by everyone behind one address

- Where: `src/lib/server/auth/throttle.ts:12-13, 85-93`.
- Scenario: `sign-in`, `invite-accept` and `setup` allow 20 attempts per 10 minutes per client address. A team
  behind one office NAT shares a single budget. One person, or a script on the office network, can block sign-in
  for the whole office until the window ends. `CF-Connecting-IP` is preferred correctly, and IPv6 counts per /64,
  so spoofing `X-Forwarded-For` or rotating IPv6 addresses inside a /64 does not bypass the throttle.
- Repro: `test/security/rb00-d1.test.ts` › "PROOF L: one IPv4 address (an office NAT) shares one sign-in budget".
- Fix: also key the budget on (client, normalised e-mail), and keep the per-client cap higher than the per-pair cap.

### L4 — Low: a small timing difference between "unknown e-mail" and "wrong password"

- Where: `src/lib/server/auth/password.ts:160-168`.
- Scenario: both paths derive a PBKDF2 key, but only the existing-account path's UPDATE matches and writes a row. On
  local D1 the medians were 31.9 ms (unknown) and 35.1 ms (known). On remote D1 a write costs more than a no-op
  UPDATE, so with many samples an insider could tell whether an address has an account. That has little value
  inside one team.
- Repro: `test/security/rb00-d1.test.ts` › "sign-in timing (informational)" prints the medians.
- Fix: optional. Make the missing-account path write too, for example by counting against a per-address row in
  `auth_attempts`.

### L5 — Low: signed-out pages that carry data have no `Cache-Control`

- Where: `src/hooks.server.ts:61-62`, which adds `private, no-store` only when `locals.user` is set. The invite page
  `src/routes/(auth)/invite/[token]/+page.server.ts:15-18` shows the invitee's e-mail and role.
- Scenario: the invite page response, whose URL holds a bearer token, can be kept in the browser's HTTP cache or the
  back/forward cache on a shared device. Exposure is small: the response has no validators, and the token is
  single use.
- Repro: `test/security/rb00-d1.test.ts` › "PROOF L: the invite page … carries no Cache-Control".
- Fix: set `cache-control: private, no-store` on every HTML or data response that has no cache-control of its own,
  or at least on routes under `(auth)`.

### L6 — Low: mention display names are whatever the author typed

- Where: `src/lib/shared/markdown.ts:49-67`.
- Scenario: `@[Ada Admin](user:<intern-id>)` renders as `@Ada Admin` while it notifies the intern. This allows
  social-engineering or spoofing of who is mentioned. It is not XSS: the name is escaped.
- Repro: `test/security/rb00-pure.test.ts` › "a mention shows any name its author typed".
- Fix (RB-03): render the mention from the user id, with the current name from D1 passed in as env, or fall back to
  plain text when the id is not an active user.

### L7 — Low: the Access identity is never tied to the Ruby account

- Where: `src/lib/server/auth/access.ts:216-220` returns `email`/`sub`, but `src/hooks.server.ts:50-53` ignores it.
- Scenario: any person Access lets in can sign in to any Ruby account whose password they know, and can accept any
  invite link. The two layers are independent. This makes M1, credential sharing and the use of leaked passwords
  easier. It may be a deliberate design choice, but the brief does not say so.
- Fix: optional. Compare `verdict.email` with `locals.user.email` (case-insensitive) and bind invite acceptance to it,
  or record an owner decision that the layers are independent on purpose.

### L8 — Low: a closed `/setup` still pays for a PBKDF2 derivation per POST

- Where: `src/routes/(auth)/setup/+page.server.ts:19-30` and `src/lib/server/auth/setup.ts:56-58`. The credential is
  derived before the guarded INSERT, and the action never calls `setupOpen` first.
- Scenario: after setup, each POST to `/setup` costs one throttle row plus about 8 ms of CPU, then gets a 404. The
  cost is capped at 20 per 10 minutes per client. CPU waste only, no bypass (the INSERT guard holds; see
  "setup after users exist" in `rb00-d1.test.ts`).
- Fix: return 404 from the action when `!(await setupOpen(db))`, before the throttle and the derivation. Keep the
  guarded INSERT as the real gate.

### L9 — Low (operations): the deploy guard and the wrangler comment disagree on the D1 placeholder

- Where: the comment at `wrangler.jsonc:28-29` says the committed D1 id is a placeholder that `npm run deploy` refuses.
  `scripts/deploy.ts:19` only refuses `00000000-0000-4000-8000-000000000000`.
- Scenario: if the committed D1 id really is a placeholder, the guard does not stop the deploy. Wrangler would then fail
  at the Time Travel step against a database that does not exist. That fails closed, but with a confusing error.
  If it is the real database id, the comment is stale.
- Fix: make the comment and `PLACEHOLDER_D1` agree. Not checked remotely (out of scope).

## Informational (no finding)

- Static assets (`/_app/*`, fonts, favicon) are served by Workers Assets before the Worker runs (`wrangler.jsonc:12`;
  the build's `_headers` sets only `X-Robots-Tag` and `Cache-Control`). They get no JWT check, no HSTS and no
  `nosniff`. They are public build output with no secrets, and Access still protects them at the edge. Consider
  adding `X-Content-Type-Options` and HSTS to `_headers`, or setting `run_worker_first` for HTML.
- markdown-it emits `style="text-align:…"` for aligned table columns, and `style-src-attr` blocks it. This is safe,
  but column alignment is silently lost (a functional bug).
- PBKDF2-SHA256 runs at 100 000 iterations, the workerd ceiling. That is below the OWASP 2023 figure (600 000) but
  is the brief's stated limit. A D1 dump would allow faster offline guessing than the OWASP figure assumes.
- The worst pathological Markdown at the 200 000-character cap (`![[` repeated) rendered in 422 ms on Node. Other
  inputs took 1–283 ms. Within the Workers limits, but RB-02 should not render twice per request.
- Whether Workers Logs attaches the request URL to `console.log` events while `invocation_logs` is off was not
  verified. If it does, `/invite/<token>` URLs reach the log store. Check once in the dashboard after the first
  deploy.

## What was tried and held

- **Access**: alg `none`, HS256 keyed with the public JWK, an empty or stripped signature, wrong `aud`/`iss`,
  expired and not-yet-valid tokens, a missing header, and empty or malformed vars (503) were all refused. The
  unsigned `Cf-Access-Authenticated-User-Email` is never read. The JWKS URL is built only from the validated env
  host. The token length is capped at 8 KB and the JWKS at 16 keys, and the fetch has a 5 s timeout. Loopback-only
  bypass: through Cloudflare's custom-domain routing a request cannot carry a `localhost` host. `workers_dev:
  false`, and `preview_urls` keeps its default of `false` (wrangler 4.152.0 schema). http→https 308 happens before
  any cookie is read.
- **CSRF**: the hook check matches Kit's check. Tried `TEXT/PLAIN;charset`, multipart without Origin,
  `Origin: null`, a sibling subdomain and an `http:` origin: all refused. JSON passes the hook but needs a CORS
  preflight, and `readFormBody` answers 415. `/logout` is POST-only. No GET changes state.
- **Open redirect**: 19 `next` vectors (`//`, `/\`, TAB/LF, single, double and triple percent-encoding, dot
  segments, ideographic space, absolute and `javascript:`) all resolve to a same-origin path.
- **Markdown XSS**: 42 vectors (raw HTML, `javascript:`/`vbscript:`/`data:`/`file:` links and images in mixed case,
  entity-encoded, percent-encoded, NUL, zero-width and NBSP variants, reference definitions, autolinks, linkify,
  attribute break-outs, mention names, tables, code) all render inert. `{@html}` appears only in
  `Markdown.svelte`. The built CSP has `script-src 'self'` plus a nonce and no `'unsafe-inline'`, `img-src 'self'`,
  `object-src 'none'`, `base-uri 'none'` and `frame-ancestors 'none'`.
- **Setup**: guarded INSERT, and the action answers 404 once users exist. The existing concurrency test confirms
  that two setups create one admin.
- **Invites**: 256-bit CSPRNG tokens, stored as SHA-256, single use under concurrency (existing test: 10 parallel
  accepts give 1 account), expiry and revocation enforced, e-mail and role taken from the row, no token in page
  data (existing test). Log lines use the route id, `redactedPath` and `strict-origin` on invite URLs.
- **Escalation and last admin**: every admin action calls `requireAdmin` and the guarded SQL re-checks
  `isActiveAdmin`. Mutual demote and disable races leave exactly one admin (existing tests). Role changes and
  disabling take effect on the next request (`resolveSession` joins `users`).
- **Sessions**: 256-bit tokens stored as SHA-256. The cookie is `__Host-`, HttpOnly, Secure and SameSite=Lax. A new
  token is issued at sign-in, setup and accept, and the old cookie's session is revoked (no fixation). A password
  change revokes the other sessions. Sign-out revokes the session and sends `Clear-Site-Data`.
- **Body limits**: 8 KiB cap enforced on the stream, a 10 s timeout, 415/400/408 and never 500. Only
  `readFormBody` parses bodies.
- **Logging**: no token, e-mail or message in logs. `errorLabel` keeps only class names. Error pages show an id.

## Checks run

- `npx vitest run test/security/rb00-pure.test.ts`: exit 0, `Tests  69 passed (69)`.
- `npx vitest run test/security/rb00-d1.test.ts`: exit 0, `Tests  9 passed (9)`. The PROOF tests passing means
  the weaknesses are present.
- `npx vite build` (local, to inspect `_headers` and the CSP): exit 0, `✔ done`.
- `npm test`: exit 0, `Test Files  17 passed (17)`, `Tests  355 passed (355)`.
- Not run: anything remote (Access, JWKS, Workers Logs, D1 timing on remote). No deploy and no commit.

## Re-check after cycle 1 (2026-10-26)

- Scope: fix commit `3baceb8` (`git show 3baceb8`) against M1, L1–L3, L5, L6, L8 and L9 above. The tree was checked
  out at `main` = `3baceb8`, with a fresh `npm ci`. No product code changed.
- L4 (sign-in timing) and L7 (Access identity not bound to the account) were **accepted** by the orchestrator. They
  are not fixed, and they do not count against the verdict.

### Verdict: PASS

There are no Medium or High findings. M1 is fixed, and every Low the orchestrator chose to fix is fixed or reduced
to a small, documented residual. There is one new Low (N1) and one test-reliability note (N2).

### Fix verification

- **M1: fixed.** `setUserStatus(… 'disabled')` and a demotion in `setUserRole` revoke the target's pending invites
  in the same `db.batch`, guarded on the change having been written (`src/lib/server/auth/users.ts:114`, `:168`).
  `findLiveInvite` and `acceptInvite` statement 1 also require `creatorMayInvite`
  (`src/lib/server/auth/invites.ts:140`, `:153`, `:216`). `createInvite` was already SQL-guarded on
  `isActiveAdmin`, so an invite made by a stale request after a demote is never written. Tried, all held:
  - demote, then re-promote: the old link stays dead, and a new invite works;
  - a demoted admin calls `createInvite`: refused;
  - 20 rounds of `acceptInvite` racing `setUserRole(… 'member')`: an account exists exactly when the accept reported
    `ok`, and no account ever came from a revoked invite. D1 runs each batch serially, so either order is safe;
  - re-enabling a disabled admin does not bring their links back. A refused demotion (last admin) revokes nothing.
- **L1: fixed.** There is one in-flight fetch per team domain (`src/lib/server/auth/access.ts:142`), with a 10 s
  back-off after a failure. `fetchKeys` catches every error, including a rejected fetch, a synchronous throw from
  `fetchFn`, invalid JSON and a non-OK status. So the shared promise always resolves (to `null` on failure), and
  the slot is always cleared. A rejected promise cannot poison the cache: after the back-off the next request
  fetched again and verified. Keys still in the cache keep verifying during the back-off. The optional
  stale-key grace period was not added, so a failed refresh past `JWKS_TTL_MS` still returns 503 (fails closed, as
  before). See N1 for the one gap left.
- **L2: fixed, with a residual.** `unlockUser` (`src/lib/server/auth/users.ts:201`) is one guarded UPDATE
  (`isActiveAdmin(actor)` and `locked_until > now`), and the action calls `requireAdmin` first. Tried, all
  refused: a member (403 from the route, SQL guard on a direct call), a disabled admin, a target that is not locked
  (a failure count of 4 is not reset), an expired lock, an unknown id and an id built like an injection.
  Residual: if the only admin is the one who is locked, nobody can unlock them, and a repeat attacker can still lock
  any account every 15 minutes. This is an insider DoS only, as the original finding said.
- **L3: reduced.** The per-client budget is now `CLIENT_MAX_ATTEMPTS = 100` per 10 minutes
  (`src/lib/server/auth/throttle.ts:20`). Per-account lockout still stops guessing at one account. The budget is
  not keyed on (client, e-mail), so an office behind one NAT address still shares one budget. A script on that
  network now needs 100 requests in 10 minutes to block the office, instead of 20. Accepted as a residual Low.
- **L5: fixed.** Every early answer is `no-store`: the CSRF refusal, the http to https 308, an Access refusal and
  the gate's redirect or 401. Pages in the `(auth)` group, every response with status 400 or higher, and every
  signed-in response are `private, no-store` (`src/hooks.server.ts:40-80`). A `cache-control` set by the route is
  kept. A closed `/setup` POST, sent through the hook, was answered 404 with `private, no-store`.
  Informational: when `handle` itself throws (for example, D1 is down inside `resolveSession`), SvelteKit's fatal
  error page answers without our cache or security headers. This was already so before the fix. That page is
  static and carries no data.
- **L6: fixed in the renderer; callers not wired yet.** Given `names`, a mention shows the current name of its id,
  or `@unknown user`, and never the typed label (`src/lib/shared/markdown.ts:74`). Ids are lower-cased on both
  sides. `mentionNames` binds one JSON parameter and is capped at 500 distinct ids
  (`src/lib/server/auth/users.ts:48`). Tried:
  - 601 ids: the real id was in position 601, past the cap, so it rendered `@unknown user`, with no error;
  - hostile ids (`") or 1=1 --`, `"]`, an empty string, a 10 000-character string): all inert;
  - an empty names map: the typed label is never shown.
  No loader passes `names` yet, because RB-00 has no content with mentions. RB-03 must pass
  `mentionNames(db, ids)` to every Markdown render of stored content. Track this in the RB-03 PRD.
- **L8: fixed.** The action calls `setupOpen` before it reads the body, counts the throttle or derives a key
  (`src/routes/(auth)/setup/+page.server.ts:21`). A 32 MiB streamed body sent through `handle` to a closed `/setup`
  got a 404. At most 2 chunks were pulled, no `auth_attempts` row was written, and `deriveBits` was not called. The
  guarded INSERT is still the real gate.
- **L9: fixed.** The `wrangler.jsonc` comment now matches `scripts/deploy.ts › PLACEHOLDER_D1`.

### New findings

#### N1 — Low: the JWKS in-flight slot has no age bound

- Where: `src/lib/server/auth/access.ts:86`, `:142-156`.
- Scenario: a fetch that never settles keeps its `inFlight` entry forever. Then every later request that needs a
  JWKS fetch joins the dead promise and waits on it. That happens on a cold cache, an unknown `kid` or a cache older
  than `JWKS_TTL_MS`. The `AbortSignal.timeout(JWKS_TIMEOUT_MS)` given to `fetch` normally prevents this. But the
  timeout belongs to the request that started the fetch. If the runtime cancels that request (for example, when the
  client disconnects) together with its subrequest and timer, the joined requests can wait until the runtime kills
  them as hung. Then all Access-gated traffic in that isolate fails until the isolate is recycled. On local workerd
  (miniflare 5), aborting the request that started the fetch did **not** break the requests that joined it: they
  got the result after 1.5 s. So this is not reproduced on the runtime. It is a missing defence in depth, not a
  demonstrated outage.
- Repro (unit): `verifyAccessJwt` with a `fetchFn` that never settles. A second request with a good `fetchFn`,
  10 TTLs later, was still waiting after 300 ms, and its `fetchFn` was never called.
- Fix: store `startedAt` with the in-flight promise, and ignore (and replace) an entry older than
  `JWKS_TIMEOUT_MS` + 1 s. Or have each request race the shared promise against its own
  `JWKS_TIMEOUT_MS` timer.

#### N2 — Informational (test reliability): the Markdown timing probe flakes on a loaded host

- Where: `test/security/rb00-pure.test.ts:96-119` (each input must render in under 2000 ms).
- The test failed in `npm test` at a load average of about 14, because other agents were running on the same host
  (`expected 2644 to be less than 2000`). Run alone, it passed. The old renderer (`4654f8f`) and the new one, timed
  in the same process, are in the same range (the `[` input took 621–968 ms with the old renderer and 430–1217 ms
  with the new one). The fix only changes how a mention is rendered, not how text is parsed, so this is not a
  product regression.
- Fix: loosen the bound (for example, 5000 ms), or compare against a baseline render in the same run, so the gate
  does not depend on host load.

### Checks run

- `npx vitest run` of an ad-hoc probe file (M1, L1, L2, L5, L6, L8, N1): exit 0, `Tests  9 passed (9)`. The file is
  kept outside the repository, in the reviewer's scratchpad.
- workerd experiment (miniflare 5.20261019.2-beta): a promise shared across requests, with the request that
  started it aborted. The request that joined got `200`; the next request started a new fetch.
- `npm run check`: exit 0, `0 ERRORS 0 WARNINGS`.
- `npm test`: exit 1, `Tests  1 failed | 367 passed (368)`. The one failure is N2, the timing probe under host load.
  The test was run once more only to read the failure, with the same result. Run alone, it passed.
- Checked against `docs/ENGINEERING_CHECKLIST.md`: invite tokens, last-admin and concurrency rules, the
  `requireAdmin` guards and logs. No new log lines and no new page data with secrets. `lockedUntil` is shown to
  admins only.
- Not run: anything remote. No commit, push or deploy.
