# RB-04 Attachments — PRD

Risk tier: **Large** (untrusted bytes stored and served from the app origin; R2 + D1 consistency; red-team review required).

Depends on: **RB-01** (task detail page, slot `<!-- RB-04:attachments -->`). Pages (RB-02) get attachment UI as soon as RB-02 is merged: the panel is mounted in `/kb/[id]` by whichever of RB-02/RB-04 merges second; if RB-02 is not merged, the page target is still supported by the server code (tested with seeded rows). Independent of RB-03. RB-00 provides `requireUser`, throttle scope `upload`, `src/lib/server/return-to.ts` (already present), env helper `src/lib/server/env.ts` (R2 binding `FILES`).

Spec conflict to settle: `CLAUDE.md` line 79 says "20 MB per file"; the owner brief says **25 MB**. This PRD uses **25 MB** (brief wins); the engineer fixes CLAUDE.md in the same PR. CLAUDE.md leaves the download route to this PRD: it is `/files/[id]`.

## Goal

Attach files to tasks and pages, download them safely, and remove them, without the app ever serving user-supplied bytes in a way a browser could execute.

## Owner decisions (defaults accepted 2026-10-26)

1. 25 MB (26 214 400 bytes) max per file; max 20 live attachments per target; one file per request.
2. Delete: uploader or admin. Soft delete (tombstone) then R2 object delete.
3. Any file type may be stored, but its served `Content-Type` comes only from a server allowlist keyed by extension, else `application/octet-stream`. No virus scanning.
4. Throttle `upload`: proposed 20 per 10 minutes per user (value in RB-00's table).
5. No per-user or global storage quota this pass.
6. Archived-project tasks still accept attachments.

## Scope

### Routes

| Route | Purpose |
|---|---|
| `POST /files` (`src/routes/files/+server.ts`) | Upload (multipart/form-data, fields `targetKind`, `targetId`, `file`, `returnTo`). Redirects (303) to the validated `returnTo` (via `return-to.ts`) with a `?uploaded=1`-style flash param, or returns JSON `{id, filename, sizeBytes, contentType}` with status 201 when `Accept: application/json`. Errors: redirect back with `?upload_error=<code>` (no JS) or JSON `{error: code, message}` with status. |
| `GET /files/[id]` (`src/routes/files/[id]/+server.ts`) | Download. `?inline=1` only honoured for safe image types. |
| `POST /files/[id]/delete` | Delete (form; redirect to validated `returnTo`; JSON when asked). |

`src/routes` is not under `(app)` for `/files` only if RB-00's auth hooks cover it; the handlers call `requireUser(event)` regardless. Both RB-01's task detail and RB-02's page view mount `<AttachmentPanel targetKind targetId returnTo>` (`src/lib/ui/attachments/AttachmentPanel.svelte`): list (icon, cleaned filename as link, human size, uploader, date, image thumbnail via `/files/<id>?inline=1` with `loading="lazy"`, Delete button when allowed), upload form `<form method=post action=/files enctype=multipart/form-data>` with file input + "Upload", and a counter "N of 20". With JS: drag-drop zone, per-file progress via `XMLHttpRequest`, queued sequentially (one request per file), inline error per file.

Shared-file edits (explicit): task detail `+page.svelte`/`+page.server.ts` (RB-01) and page view (RB-02) — replace the marked slot with the panel and load the target's attachments via `listAttachments`. Nothing else is shared.

### Server modules (`src/lib/server/attachments/`)

- `limits.ts` — `ATTACHMENT_LIMITS = { maxBytes: 26_214_400, maxPerTarget: 20, maxFilenameChars: 120, bodyOverheadBytes: 1_048_576 }`.
- `filename.ts` — `cleanFilename(raw)`: NFC; strip `/ \ : * ? " < > |`, C0/C1 controls, DEL, zero-width and bidi chars (U+200B–200F, U+202A–202E, U+2066–2069, U+FEFF); collapse whitespace to one space; trim spaces and leading/trailing dots; if > 120 chars keep the extension (≤ 16 chars) and truncate the stem; empty → `file`; reserved Windows device names (`CON`, `NUL`, …) prefixed with `_`.
- `content-type.ts` — `classify(filename, bytesHead)` → `{ contentType, inlineSafe }`. Table (extension → type): `pdf application/pdf`, `txt text/plain`, `md text/markdown`, `csv text/csv`, `json application/json`, `zip application/zip`, `docx/xlsx/pptx` their OOXML types, `odt/ods/odp`, `png image/png`, `jpg|jpeg image/jpeg`, `gif image/gif`, `webp image/webp`, `mp4 video/mp4`, `mp3 audio/mpeg`. Everything else (including `html`, `svg`, `js`, `xml`, `exe`) → `application/octet-stream`. The client-sent type is ignored. `inlineSafe` is true only for png/jpeg/gif/webp **and** the first bytes match the magic number (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `GIF87a|GIF89a`, WebP `RIFF….WEBP`); on mismatch the file is stored as `application/octet-stream`.
- `repo.ts` — `listAttachments(db, kind, id)`, `getAttachment(db, id)`, `insertAttachmentGuarded(db, row)`, `tombstoneAttachment(db, id, now)`, `countLive(db, kind, id)`.
- `target.ts` — own small `targetIsLive(db, kind, id)` (task: live task; page: live page). Does not import RB-03.
- `service.ts` — `uploadAttachment(event, input)`, `deleteAttachment(event, id)`, `buildDownloadResponse(event, id, { inline })`.
- `permissions.ts` — `canDeleteAttachment(actor, row)` (uploader or admin).

### Validation and limits

- `targetKind` ∈ `TARGET_KINDS`; `targetId` uuid; target must be a live task/page.
- Request: `Content-Type` must be `multipart/form-data`; if `Content-Length` is present and > `maxBytes + bodyOverheadBytes` → 413 before parsing. Exactly one `file` part that is a `File`; `file.size` 1..26 214 400 bytes (0-byte → 422 "File is empty"; larger → 413).
- Filename: `cleanFilename(file.name)` is what is stored and shown; the original is never stored.
- Count: ≤ 20 live (non-tombstoned) attachments per `(target_kind,target_id)`.
- `returnTo`: only via `return-to.ts` validator (same-origin relative paths); otherwise default to the target's canonical page.
- Error codes: `too_large` (413), `empty` (422), `limit` (409), `target_gone` (404), `bad_request` (400), `throttled` (429), `storage` (503).

### Upload sequence (R2 first, then D1; no transaction spans both)

1. `requireUser`; consume throttle `upload` (429 → `throttled`).
2. Validate headers/form, target liveness, pre-check count (fast fail, `limit`).
3. `id = newId()`, `r2Key = 'att/' + crypto.randomUUID()` (never derived from user input); classify; read first 16 bytes via `file.slice(0,16)`.
4. `FILES.put(r2Key, file, { httpMetadata: { contentType }, customMetadata: { attachmentId: id } })` (the `File` Blob is passed so R2 has a known length). Failure → 503 `storage`, nothing in D1.
5. D1 guarded insert, one statement: `INSERT INTO attachments (id,target_kind,target_id,r2_key,filename,content_type,size_bytes,uploaded_by,created_at) SELECT … WHERE (SELECT count(*) FROM attachments WHERE target_kind=:k AND target_id=:t AND deleted_at IS NULL) < 20 AND EXISTS (<target live>)`. This keeps the 20 cap correct under concurrent uploads and a vanished target.
6. `changes = 0` → best-effort `FILES.delete(r2Key)`; re-read to report `limit` or `target_gone`.
7. D1 throws → best-effort `FILES.delete(r2Key)` (awaited, errors swallowed), log one line `attachment_orphan_candidate` with `errorLabel(e)` and the R2 key only (never filename or content), return 503. If the cleanup delete also fails the object is an **orphan**: harmless (unreachable, no row), documented in `docs/RUNBOOK.md` as "list `att/` in R2 and delete keys with no `attachments.r2_key` row" (manual sweep; scripted sweeper is out of scope).

### Download (`GET /files/[id]`)

1. `requireUser` (signed-out → refused per RB-00; never a public URL).
2. `id` must be a uuid; load the row `deleted_at IS NULL`; verify the parent target is live (`targetIsLive`); else **404** (same answer for missing, tombstoned, parent deleted, malformed).
3. `FILES.get(r2Key)`; missing object → 404 (log `attachment_object_missing` with attachment id only).
4. Headers: `Content-Type` = stored type if in the allowlist else `application/octet-stream`; `Content-Length`; `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987 percent-encoded>` — **inline** only when `?inline=1` and the stored type ∈ {png, jpeg, gif, webp}; `X-Content-Type-Options: nosniff`; `Content-Security-Policy: default-src 'none'; sandbox`; `Cross-Origin-Resource-Policy: same-origin`; `Cache-Control: private, max-age=0, must-revalidate`; `ETag` from the R2 object (If-None-Match → 304 after the auth checks). Body is the R2 stream; no Range support.
5. ASCII fallback: non-ASCII, quotes, backslash, CR/LF replaced by `_`.

### Delete

`requireUser`; load row (live); `canDeleteAttachment` else 403; guarded `UPDATE attachments SET deleted_at=:now WHERE id=:id AND deleted_at IS NULL` (idempotent); **only after** it commits: `FILES.delete(r2Key)`. R2 failure is logged (`attachment_r2_delete_failed`, key only) and the user still sees success (the tombstone already blocks downloads). Never delete the R2 object first. The `r2_key` unique index means a key is never reused.

### Authorization

| Action | Rule |
|---|---|
| list on page | any active user (rendered by host page) |
| upload | any active user, live target |
| download | any active user, live row, live parent |
| delete | uploader or admin |

### States

Panel: empty "No attachments"; uploading (progress, disabled button); per-file error messages: "File is larger than 25 MB", "File is empty", "This item already has 20 attachments", "Upload failed, try again", "You're uploading too fast, wait a moment", "This item no longer exists"; success only after the server returns 201/redirect. Deleting: confirm (JS `confirm` dialog; without JS a "Delete" submit with a hidden `confirm=yes` and a `<details>` warning). Missing R2 object on download shows a plain 404 page.

## Acceptance criteria

1. Signed-out `GET /files/<id>`, `POST /files`, `POST /files/<id>/delete` are refused; no bytes are returned.
2. Upload of a 1-byte, a 25 MB (exactly 26 214 400) file succeeds; 26 214 401 bytes → 413 and no R2 object/D1 row; 0 bytes → 422.
3. A request with oversized `Content-Length` is rejected before the body is read.
4. 21st upload to one target → 409 `limit`, R2 object removed; 20 concurrent-ish uploads to a target with 19 live files yield exactly one success (integration).
5. Tombstoned attachments do not count toward 20.
6. Upload to missing/deleted task or page → 404; nothing stored.
7. Stored `r2_key` matches `^att/[0-9a-f-]{36}$` and never contains user input; two uploads with the same filename get distinct keys.
8. Filenames `../../etc/passwd`, `a‮gnp.exe`, 300-char names, `CON.txt`, names with quotes/CRLF/emoji, and empty names are cleaned as specified; stored name ≤ 120 chars.
9. Client-supplied `Content-Type: text/html` on `evil.html` is stored as `application/octet-stream`; `x.png` with non-PNG bytes is stored as `application/octet-stream` and is not inline-able.
10. Download of a PDF returns `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, the CSP sandbox header, correct length and exact bytes.
11. `?inline=1` returns `inline` only for png/jpeg/gif/webp; for every other type it still returns `attachment`.
12. Non-ASCII filename downloads with a correct `filename*` and a safe ASCII fallback; header injection via CRLF in a filename is impossible.
13. Download of a tombstoned attachment, of one whose task/page was soft-deleted, of a malformed or unknown id, all return the same 404.
14. If the D1 insert throws after the R2 put (injected failure), the R2 object is deleted, the response is 503, and no row exists; if the cleanup delete also fails, an `attachment_orphan_candidate` log line with the key (no filename) is emitted.
15. If `FILES.put` fails, no D1 row exists and the response is 503.
16. Delete by uploader and by admin succeeds; by another member → 403 and nothing changes; repeat delete is idempotent; the D1 tombstone is written before the R2 delete (ordering asserted via call log); R2 delete failure still yields success + log.
17. Exceeding throttle `upload` returns 429 and stores nothing.
18. `returnTo=https://evil.example` or `//evil.example` is ignored and the redirect goes to the target page.
19. Upload and delete work with JS disabled (form post + redirect with flash/error code).
20. Logs never contain filenames, file content or user ids beyond attachment ids/keys.
21. `check`, lint, tests green; no migration added.

## Test plan

Unit: `cleanFilename` table; `classify` + magic-byte check; content-disposition builder (ASCII fallback and RFC 5987); limit constants; error-code mapper; permission helper.
Integration (`openLocalD1`, `fakeEvent`, `test/helpers/fake-r2.ts` — in-memory `put/get/delete/head` with failure injection and a call log, RB-04 only): upload happy path; each error code; guarded count race; D1-failure orphan handling; R2-put failure; download header set and 304; inline policy; 404 equivalence set; delete ordering and failure tolerance; throttle; two roles + deactivated uploader (attachment still downloadable and deletable by admin).
Red-team checklist: HTML/SVG upload opened from the app origin cannot execute (headers), path traversal in names/keys, MIME confusion, IDOR across targets, CSRF on upload/delete (RB-00 CSRF applies; cross-site form post rejected), oversized streaming bodies, filename XSS in the panel (rendered as text).
Manual: 25 MB upload on the deployed host, drag-drop, thumbnails, phone width.

## Out of scope

Image resizing/thumbnails server-side, virus scanning, Range/resumable/chunked uploads, multi-file single request, versioning/replace, storage quotas and usage dashboard, scripted orphan sweeper (manual RUNBOOK procedure instead), attachments on comments, public/share links, ZIP-all download, previews of PDFs/Office files, restore of deleted attachments, purge of tombstoned R2 objects beyond best-effort delete.

## Architecture notes

Reuse `newId`, `errorLabel` (`src/lib/server/util.ts`), `return-to.ts`, `attachments` table and `attachments_target_idx`, env helper for the `FILES` binding. New trees: `src/routes/files/**`, `src/lib/server/attachments/**`, `src/lib/ui/attachments/**`, `test/helpers/fake-r2.ts`. Edits to RB-01/RB-02 host pages limited to the slot. No secrets.

## Schema additions

None. Considered and rejected: `purged_at` for retrying failed R2 deletes (R2 delete is idempotent; manual sweep is enough at this scale). If the owner wants automated retries later, propose `migrations/0002_attachments_purged.sql`: `ALTER TABLE attachments ADD COLUMN purged_at integer;`.
