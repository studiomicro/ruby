# RB-04 Attachments — QA report

**Verdict: PASS**

## Commands run
- `npm ci --prefer-offline --no-audit --no-fund` — exit 0 (real npm cache).
- `npm run gates` — exit 0; check (--fail-on-warnings) clean, lint clean, vitest 35 files / 826 tests passed (local D1 via `openLocalD1`, in-memory fake R2 fixture), build ok.
- `CI=1 RUBY_E2E_PORT=4391 npm run test:e2e` — exit 0; 99 passed, 14 skipped (pre-existing skips in rb01-qa/projects/shell, none in attachments); real local wrangler/miniflare D1+R2, fresh server. Projects iphone-402, iphone-440, phone-360, desktop; attachments.spec ran in all four (task, page+image, empty file, no-JS).
- No migration added (diff has none), so `db:reset:local` not needed.

## Criteria (evidence: `test/integration/attachments.test.ts` unless noted)
1. Signed-out refused, no bytes: PASS — "signed out" test; e2e hooks.
2. 1 byte / exactly 26 214 400 ok; +1 → 413, nothing stored; 0 → 422: PASS — "stores a 1-byte file", "accepts exactly 25 MB…", "an empty file is 422".
3. Oversized Content-Length refused before body read: PASS — "oversized Content-Length…"; `body.ts` checks header first, then bounds the stream.
4. 21st → 409, R2 object removed; 19 live + concurrent → exactly one success: PASS — two tests.
5. Tombstones not counted: PASS.
6. Missing/deleted task, page, deleted project → 404: PASS.
7. r2_key `att/<uuid>`, distinct for same name: PASS (service.ts:105 `crypto.randomUUID()`).
8. Filename cleaning: PASS — unit table + "names are cleaned before storage".
9. evil.html and fake x.png → octet-stream, not inline: PASS.
10. PDF headers/length/bytes: PASS. Deviation (accepted): `Cache-Control: private, no-store` (PRD: private, max-age=0, must-revalidate); ETag/304 tested.
11. inline only png/jpeg/gif/webp: PASS.
12. filename* + ASCII fallback, no CRLF injection: PASS.
13. Same 404 for tombstoned/parent-deleted/malformed/unknown/object-missing: PASS.
14. D1 throw after put → object deleted, 503, no row; orphan log with key only: PASS (cleanup-fail → `attachment_orphan_candidate` is in service.ts:68; "D1 failure…" test + logs test).
15. R2 put failure → 503, no row: PASS.
16. Delete uploader/admin ok, other member 403, idempotent, tombstone before R2 delete (call log), R2 failure still success + log: PASS. Deviation (accepted): missing `confirm=yes` → 400.
17. Throttle 21st/10min → 429, nothing stored: PASS.
18. Evil returnTo ignored (https://, //, /\, javascript:): PASS.
19. No-JS upload/delete with redirect+flash: PASS — e2e "without JavaScript" on all 4 viewports; integration 303 tests.
20. Logs without filenames/content/user ids: PASS — "logs never carry…"; grep of all console calls in `src/lib/server/attachments` shows only ids/keys/error labels.
21. check/lint/tests green, no migration: PASS.

Extra checks: cross-site form POST refused by hooks `isCrossSiteForm` (global CSRF); file input has no `accept` attribute (iOS picks from Photos/Files; `multiple` only after hydration, one request per file); panel fits 402/440/360/desktop without overflow (e2e); filename rendered as text; CLAUDE.md and ENGINEERING_CHECKLIST say 25 MB; RUNBOOK has orphan sweep.

## Findings
No FAIL. Observations (informational, no severity above Low):
- Low: `src/lib/server/attachments/service.ts:96-100` consumes the upload throttle before validation, so rejected uploads (empty, bad type) count toward 20/10min. By design per PRD step 1.
- Low: CSP header is `sandbox; default-src 'none'` (order differs from PRD; equivalent).
- Info: no checklist item violated.
