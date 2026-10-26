# RB-04 Attachments — Security report (red team, cycle 1)

Scope: `git diff main..HEAD` at `33c6510` (wip(rb-04-attachments): cycle 1) — `src/lib/server/attachments/*`,
`src/lib/shared/attachments.ts`, `src/lib/ui/attachments/AttachmentPanel.svelte`, `src/routes/(app)/files/**`, the
two host-page slot edits, `test/helpers/fake-r2.ts`. Checked against the PRD and `docs/ENGINEERING_CHECKLIST.md`.
Local D1 and the local R2 bucket from `openLocalD1().env.FILES` only; nothing remote was touched.

## Verdict: **PASS**

No high or medium findings. Five low findings are listed for tracking.

## What was attacked and held

| Area | Result | Proof |
|---|---|---|
| Stored XSS: `.html/.htm/.svg/.xml/.xhtml/.js`, `evil.png.html`, `evil.html\0.png`, `evil.html.` with client type `text/html` | Stored and served as `application/octet-stream`, `attachment`, even with `?inline=1` | rb04-d1 "HTML, SVG, XML…" |
| Polyglot: PNG magic + HTML body named `.png` | `image/png` inline, with `nosniff` + `sandbox; default-src 'none'`: the browser renders an image, never HTML | rb04-d1 "a PNG header with an HTML body" |
| Image extension without magic (HTML as `.jpg`, `GIF88a`, truncated PNG, `RIFF…WAVE`) | octet-stream, not inline | rb04-pure |
| Prototype keys as extension (`.__proto__`, `.constructor`) | octet-stream (`Object.hasOwn`) | rb04-pure |
| PDF with OpenAction JS, txt/csv/json/md | always `attachment`, sandbox CSP | rb04-d1 |
| Content-Disposition: CRLF, quotes, backslash, `;`, `%`, `'()*`, emoji/CJK, lone surrogate, 5000-char name, bidi | Header always accepted by `Headers`, parses as exactly one `filename` + one `filename*`, `filename*` decodes to the stored name; backstop holds even for an uncleaned name | rb04-pure |
| File names: traversal, NUL, C0/C1, bidi overrides/isolates, BOM, U+2028/9, device names (`CON.txt`, `con .tar.gz`, `nul​.txt`), leading/trailing dots | Cleaned per PRD; ≤ 120 code points; never empty | rb04-pure |
| R2 key | `att/<uuid>` from `crypto.randomUUID()`; `customMetadata` holds only the attachment id; a `../../att/../etc/passwd` name never reaches the key | rb04-d1 |
| MIME sniffing / embedding | `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Security-Policy: sandbox; default-src 'none'`; script/style loads of octet-stream, text or image types are blocked by nosniff | rb04-d1 header asserts |
| Range | ignored: 200 with the full body, no `Content-Range` | rb04-d1 |
| ETag / 304 | 304 only after auth and live checks; old ETag (and `*`) after delete, after task delete, or after project delete → 404 | rb04-d1 |
| Cache | `private, no-store` on downloads (stricter than the PRD's `max-age=0, must-revalidate`; 304 is then rarely used — harmless) | rb04-d1 |
| AuthN through the real hook | signed-out POST /files and delete → 401, GET download → 303 to `/login`; no handler runs, no R2 call; a disabled user's live session never reaches the handlers | rb04-d1 |
| CSRF through the real hook | cross-site, `Origin: null` and Origin-less multipart/urlencoded posts to upload and delete → 403 before routing, nothing stored or deleted; csrf.ts and body.ts parse the content type identically (`multipart/form-data, text/html` is refused by both) | rb04-d1, rb04-pure |
| IDOR | another member's delete → 403, file unchanged; admin delete succeeds and removes the object; hidden/missing/malformed ids → the same 404 | rb04-d1 |
| Target confusion | task id sent as `page`, `targetKind=comment`, SQL-ish and path-ish `targetId`, unknown upper-case uuid → 400/404, no row, no object | rb04-d1 |
| 20 cap under concurrency | 18 live + 6 parallel uploads → exactly 2 × 201, 4 × 409; exactly 20 rows and 20 R2 objects (losers' objects removed) | rb04-d1 |
| Streaming size | chunked body without Content-Length cut at the bound (413) before the 28 MB stream is drained, no object, no row; a body longer than its declared (small) Content-Length is cut; an oversized declared length is refused without reading; a stalled body hits the timeout | rb04-d1, rb04-pure |
| Multipart edge cases | two files, no file, `file` as a text field → 400 and no `put`; 500 KB `returnTo` and 500 KB extra field → bounded, redirect falls back to the task page | rb04-d1 |
| Throttle | counted before the body is read; failed (415) attempts count; the 21st in a window → 429 with `Retry-After`, nothing stored, no R2 call | rb04-d1 |
| Orphans | D1 failure after put → object deleted; delete failure too → `attachment_orphan_candidate` with the key only | rb04-d1 (and QA) |
| Logs | over put failure, insert failure + cleanup failure, and R2-delete failure: no file name, no content, no user id or e-mail in any log line | rb04-d1 |
| Open redirect | `https://evil`, `//evil`, `/\evil`, `\\evil`, `/%2F%2F…`, double-encoded, `/<TAB>/evil`, `javascript:`, `https:evil` → target page | rb04-pure |
| Panel XSS | hostile file name, uploader name and `returnTo` render escaped (`&lt;`, `&quot;`); the only `<img>` is the thumbnail with a server-made src; no `{@html}` | rb04-pure (SSR) |
| Page data | `listAttachments` never selects `r2_key`; the panel gets no key | code review, QA |

## Findings

### L1 (low) — Whole upload body buffered in memory; concurrent large uploads can exhaust an isolate

`src/lib/server/attachments/body.ts:77` — `new Response(stream).formData()` buffers the whole multipart body (up to
`maxBytes + bodyOverheadBytes` = 27.2 MB), and `File` is then passed to `FILES.put`. Workers isolates have a 128 MB
limit and can serve several requests at once, so four or five signed-in users (or one user with parallel tabs within
their 20-per-10-minute budget) uploading ~27 MB at the same moment can push an isolate over its limit and abort the
other requests it is serving. Requires an active account; the per-user throttle bounds it.
Repro: 5 parallel 27 MB uploads against a deployed host; watch for "Worker exceeded memory limit".
Fix (later pass): stream the file part to R2 (parse the multipart boundary in a `TransformStream` and `put` a
`FixedLengthStream`), or accept and record the limit in the RUNBOOK.

### L2 (low) — Invisible "letter" fillers survive file-name cleaning (display spoofing)

`src/lib/server/attachments/filename.ts:7` — the strip set is Cc/Cf/Cs/Zl/Zp plus Zs collapse. Blank-rendering
code points that are letters or symbols (U+3164 HANGUL FILLER, U+115F/U+1160, U+FFA0, U+2800 BRAILLE BLANK) are kept,
so `invoice.pdf<60 × U+3164>.exe` is stored and shown as `invoice.pdf` followed by blank space and `.exe`, which the
panel's ellipsis may hide. Proof: rb04-pure "LOW L2". The served type is still octet-stream and the PRD's list is met.
Fix: add `ᅟᅠㅤﾠ⠀` (and optionally `\p{Default_Ignorable_Code_Point}`) to `INVISIBLE`, or
collapse them like spaces.

### L3 (low) — A user disabled mid-upload still gets the file stored

`src/lib/server/attachments/service.ts:84-137` — the session is checked once by the hook; the body may stream for up
to `UPLOAD_BODY_TIMEOUT_MS` (10 minutes, `body.ts:13`) and the row is then inserted with no re-check. A user
deactivated (and whose sessions were deleted) while their body is still arriving still lands an attachment.
Proof: rb04-d1 "LOW L3" (body paused, user disabled and sessions deleted, body released → 201, row written).
Fix: add `AND EXISTS (SELECT 1 FROM users WHERE id = ?8 AND status = 'active')` to the guarded insert
(`repo.ts:91-93`); a 0-change result then deletes the object as today.

### L4 (low) — Download responses can be framed cross-origin

`src/lib/server/attachments/service.ts:178` — the download CSP is `sandbox; default-src 'none'` without
`frame-ancestors`, and no `X-Frame-Options` is set (the app's own `frame-ancestors 'none'` in `src/lib/server/csp.ts:24`
applies to pages only). A same-site attacker page (session cookie is `SameSite=Lax`, so cross-site frames get the
sign-in redirect) can frame `/files/<id>?inline=1`. Pixels stay unreadable (SOP) and the document is sandboxed, so the
impact is limited to UI redress. Proof: rb04-d1 "LOW L4".
Fix: `sandbox; default-src 'none'; frame-ancestors 'none'` (thumbnails use `<img>`, which `frame-ancestors` does not
affect).

### L5 (low) — Bytes of files on deleted tasks/pages are kept indefinitely

`src/lib/server/attachments/service.ts:222-223` — once a task, page or project is soft-deleted, `deleteAttachment`
answers 404, so nobody (not even the uploader or an admin) can remove those files, and the RUNBOOK sweep keeps them
because their rows are still live (`deleted_at IS NULL`). They are unreachable (every download re-checks the parent;
proof: rb04-d1 "a delete on a file whose task was deleted is 404"), so this is data retention, not exposure. It is
consistent with soft-delete-and-restore and the PRD's out-of-scope purge.
Fix (owner decision): document in the RUNBOOK that files of deleted parents stay until a purge feature exists, or let
an admin delete attachments of a deleted parent.

## Informational

- Content-Type allowlist, `classify` on the cleaned name, and served type re-checked against `SERVED_TYPES` on every
  download: a tampered `content_type` in D1 still serves octet-stream (QA test).
- Firefox opens PDF attachments in pdf.js despite `attachment`; PDF scripting there is sandboxed and the CSP sandbox
  applies. No action.
- Windows also reserves `COM¹`–`COM³`, `LPT¹`–`LPT³`, `CONIN$`, `CONOUT$`; browsers sanitise download names, so no
  action.
- Upload `returnTo` is honoured from both the query string and the form; both go through `safeReturnTo`.

## Engineering checklist (attachments section)

Server-made R2 keys ✔; authorised download through one route after `requireUser` and live checks ✔; sanitised
`Content-Disposition`, `nosniff`, HTML/SVG as attachment ✔; 25 MB cap enforced on the stream ✔; type from an
allowlist else octet-stream ✔; R2 first then D1, object deleted on row failure, idempotent cleanup ✔; tombstone before
R2 delete ✔; no file names in logs ✔; CSRF via the shared hook ✔; no migration ✔.

## Commands

| Command | Exit | Decisive line |
|---|---|---|
| `npm ci --prefer-offline --no-audit --no-fund && npx svelte-kit sync` | 0 | — |
| `npx vitest run test/security/rb04-d1.test.ts test/security/rb04-pure.test.ts` | 0 | `Tests  37 passed (37)` |
| `npm test` | 0 | `Test Files  37 passed (37)` / `Tests  863 passed (863)` |
| `npx eslint test/security/rb04-*.test.ts` (after `prettier --write`) | 0 | no output |

Proof tests: `test/security/rb04-pure.test.ts` (16), `test/security/rb04-d1.test.ts` (21). Tests named "LOW Ln"
assert the current (weak) behaviour of each low finding; flip them when it is fixed.

## Re-check after cycle 2 (2026-10-26)

Scope: `git show HEAD` at `2382961` (wip(rb-04-attachments): cycle 2), rebased on main with RB-03 comments. Local
D1 and the local R2 bucket from `openLocalD1().env.FILES` only, wrapped by `spyR2` and a per-part failure proxy.
Nothing remote was touched. New proof tests: `test/security/rb04-cycle2-pure.test.ts` (20) and
`test/security/rb04-cycle2-d1.test.ts` (11).

### Verdict: **PASS**

L1–L5 are fixed. There are no high or medium findings. One new low finding (N1) and one residual low (R1) are
tracked, plus four informational notes.

### Cycle 1 findings

| Id | Status | Proof |
|---|---|---|
| L1 body buffered | **Fixed.** `multipart.ts` streams each part and holds back only a delimiter-sized tail. `r2-writer.ts` holds at most one 5 MiB part. Measured peak reader buffer is one chunk plus 200 B for a 25 MiB body. Residual: R1. | cycle2-pure "CPU: pathological bodies", rb04-pure |
| L2 invisible fillers | **Fixed.** `\p{Default_Ignorable_Code_Point}` and U+2800 are stripped. The panel shows the real last extension in a badge, rendered as escaped Svelte text. `invoice.pdf<60×U+3164>.exe` becomes `invoice.pdf.exe` with badge `EXE`. | cycle2-pure "L2 badge" |
| L3 disabled uploader | **Fixed.** The guarded insert requires `users.status = 'active'`. Proven on the multipart path: the user is disabled after 6 MiB of an 11 MiB body, the upload completes, the object is deleted again and the answer is 401. | cycle2-d1 "uploader disabled mid-multipart" |
| L4 framing | **Fixed.** `frame-ancestors 'none'` and `X-Frame-Options: DENY` are set on 200 and 304 responses (`fileHeaders`). | rb04-d1 "LOW L4 (fixed)" |
| L5 retention | **Fixed.** See "Purge" below. | cycle2-d1 "retention purge", integration |

### Streaming parser and R2 writer: what was attacked and held

| Attack | Result |
|---|---|
| Boundary split at every chunk edge. Chunk sizes 1 to delimiter+3, the edge sizes ±1 and random sizes. Four boundaries: 1 char, the WebKit form, 70 chars, and every special character. | A 3 KB hostile binary round trips byte for byte in every plan. |
| Partial-delimiter false positives (`\r`, `\r\n--`, `\r\n--BOUNDAR`, `\r\n\r\n--B`, `--B--` with no CRLF) inside file bytes, including at the very end of the file | Round trip exact; the held-back tail is released correctly |
| Full delimiter inside the file followed by junk | 400. RFC 2046: the boundary must not occur in the body. |
| Boundary parameter | 1–70 chars accepted. 71 chars, empty, a trailing space and a missing parameter → 400. Quoted, unquoted and case-insensitive forms work. `multipart/form-data, text/html` and `multipart/mixed` → 415. |
| Boundary in a quoted filename (`--B--.txt`) | Treated as a name only |
| Header folding, duplicate or missing `Content-Disposition`, `attachment;` instead of `form-data`, no `name` | 400 |
| Header block over 8 KiB, or one that never ends | 400 after fewer than 20 reads |
| More than 16 parts | 400 |
| Missing final boundary, garbage after a delimiter, a body that stops mid-part | 400. On the multipart path the R2 upload is aborted and never completed. |
| `filename*` with a bidi override, or with bad percent-encoding | Override wins and is stripped by `cleanFilename`; bad encoding → 400 |
| A file part before `targetKind`/`targetId` | 400 with zero R2 calls |
| A second file part after a 6 MiB first | 400. The first upload is aborted and no object is left. |
| A field that never ends (chunked, no Content-Length) | 413 at the body bound; the reader holds under 70 KB |
| Size cap at part edges | Exactly 25 MiB = five 5 MiB parts → 201. 25 MiB + 1 → 413, `abort`, no `complete`, no row, no object. |
| Byte-exact round trip through R2 multipart | 12 MiB + 13 B of binary dense with CRLF, `--` and near-boundaries, sent in 65 537 B chunks. Calls are `multipart`, `part 1`, `part 2`, `part 3`, `complete`. The download is identical (`Buffer.compare` = 0). |
| Client goes away after 7 MiB | 400. Calls are `multipart`, `part 1`, `abort`. No row, no object. |
| R2 refuses part 2 | 503, `abort`, no row, no object |
| Trickle | The deadline is enforced per read; a 150 ms deadline test is cut under 1 s. Production uses 10 minutes. |
| CPU, 25 MiB of near-delimiters (70-char boundary) or all-CR bytes at 64 KiB chunks | 57 ms and 276 ms. Linear: the delimiter starts with CRLF and boundary characters exclude CR, so partial matches cannot overlap. |

### Purge (`/admin/attachments`)

| Check | Result |
|---|---|
| Member | Load and action → 403 |
| Disabled admin, live session, through the real hook | The action is never reached |
| Cross-site POST (CSRF) through the hook | 403 before routing |
| Missing confirmation | 400 |
| 30-day rule re-checked at write time | One guarded `UPDATE … WHERE id IN (SELECT … PURGEABLE …) AND deleted_at IS NULL RETURNING`. A task deleted 29 days 23 h 59 min ago is kept. A restored item is kept (integration test). |
| Batch bounds | 130 purgeable rows on one task: the first run purges 100 (`more: true`), the second purges 34 (`more: false`) |
| No deletion of live parents' files | Untouched: a live task, a live team-space page, a task in an archived project, and the young task. Purged: the old task, a task in a project deleted 45 days ago, and a project-scoped page in that project. Exactly 134 rows tombstoned and their objects gone. |
| No deletion of other targets | Only rows matching `PURGEABLE` for their own `target_kind`/`target_id` |

### Rebase (RB-03 + RB-04 on the task and KB page loaders)

Both loaders call `requireUser` first. The task loader 404s a deleted task before building either panel. The KB
loader uses `requirePage`. Comment actions go through `taskFromParams`/`projectFromParams` and
`requireUser`/`requirePage`. Probe: a member gets both `comments` and `attachments` on the task and the page, and no
`att/` key appears in either page's data. Signed out → 401. After the task is deleted → 404.

### New findings

#### N1 (low): per-read cost of the multipart reader grows with tiny chunks

`src/lib/server/attachments/multipart.ts:134-158` and `:220-225`. Each `fill()` arms a `setTimeout`, runs a
`Promise.race` and copies the whole held buffer into a new array. The header search rescans from 0 after every read.
Linear in bytes at normal chunk sizes, but the cost per read is fixed.

Measured with one-byte reads in Node: 0.84 s per MiB of file body, which extrapolates to about 21 s for 25 MiB. That
is near the Workers default CPU limit of 30 s (no `limits.cpu_ms` in `wrangler.jsonc`). Sixteen 8 KiB header blocks
read one byte at a time cost 0.2 s.

Impact is limited:
- It needs a signed-in user.
- The runtime has to hand the Worker tiny chunks, which coalescing usually prevents.
- The body bound, the 10-minute deadline and the 20-per-10-minutes throttle cap it.
- The worst case is the attacker's own request hitting the CPU limit.

Repro: `cycle2-pure "CPU: 1-byte chunks"`.

Fix (later): arm one deadline timer per reader, not per read. Append into a growable buffer instead of copying
everything. Resume the header search at `buf.length - 3`.

#### R1 (low, residual of L1): one user can still hold roughly 100 MiB in one isolate

Each upload holds up to one 5 MiB part plus one input chunk. While the buffer grows from 4 MiB to 5 MiB, both
arrays briefly exist (about 9 MiB). The throttle allows 20 uploads per user per 10 minutes, and they may run in
parallel. One member who sends 5 MiB on each of 20 parallel uploads and then stalls can therefore approach the
128 MB isolate limit. Cycle 1 needed only four or five 27 MB bodies, so this is much better but not gone.

Fix (optional): add a per-isolate in-flight upload counter (for example a maximum of 4 and a 503 beyond it), or
accept the risk and record it in the RUNBOOK.

### Informational

- **Worker cancellation.** If the runtime cancels the request (client disconnect), the `catch` and `abort()` may not
  run, which leaves an incomplete R2 multipart upload. Those are billed as storage until aborted. `docs/RUNBOOK.md`
  lines 106–109 tell the operator to check the bucket's "abort incomplete multipart uploads" lifecycle rule. Confirm
  the rule on `ruby-files` before deploy (owner action; not checked here, nothing remote was touched).
- **Boundary parser differential.** The first `; boundary=` match wins, even inside another quoted parameter:
  `x="; boundary=evil;"; boundary=real` → `evil`. Junk after a closing quote is ignored (`boundary="a"b"` → `a`).
  No impact: nothing upstream inspects bodies.
- **Duplicate parameters.** In `Content-Disposition`, the first duplicate parameter wins
  (`name="file"; name="targetId"` → `file`). Text fields are first-wins too. Consistent, no impact.
- **Blank-looking code points still kept.** U+1D159, U+16FE4 (with Node's current Unicode tables) and U+0F0C survive
  cleaning. The extension badge shows the real last extension whatever the name, so no action.

### Engineering checklist (attachments)

Unchanged: ✔ on every attachments item. R2 keys are still server-made (`att/<uuid>`). Object-first then row, with
cleanup on every failure path, now covers the multipart path too: abort before `complete`, delete after it. The cap
is enforced on the stream per chunk. No file names in the new logs: `attachment_purge` logs a count only and
`attachment_purge_r2_delete_failed` logs a count and an error class. The purge route uses `requireAdmin` in both load
and action. CSRF goes through the shared hook. No migration.

### Commands

| Command | Exit | Decisive line |
|---|---|---|
| `npm ci --prefer-offline --no-audit --no-fund && npx svelte-kit sync` | 0 | — |
| `npx vitest run test/security/rb04-cycle2-pure.test.ts` | 0 | `Tests  20 passed (20)` |
| `npx vitest run test/security/rb04-cycle2-d1.test.ts` | 0 | `Tests  11 passed (11)` |
| `npx prettier --write` + `npx eslint --fix test/security/rb04-cycle2-*.test.ts` | 0 | no output |
| `npm test` | 0 | `Test Files  46 passed (46)` / `Tests  1031 passed (1031)` |
