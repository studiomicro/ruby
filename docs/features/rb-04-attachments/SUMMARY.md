# RB-04 Attachments — summary

**Status: complete** (2026-10-26).

Files on tasks and pages, stored in R2 and served only through authorised download routes.

- QA: PASS (no product defects).
- Red team: PASS with 5 Low (memory buffering, invisible filename characters, uploader disabled mid-stream,
  framing, files of deleted parents kept forever) → all fixed in cycle 2 (streaming multipart reader + R2 writer,
  name cleaning + type badge, active-uploader guard, frame-ancestors/XFO, admin purge) → re-check PASS.
- Open Low follow-ups: N1 parser CPU with 1-byte chunks; R1 memory with many parallel uploads (docs/TASKS.md).
- Owner check: an R2 lifecycle rule aborting incomplete multipart uploads on `ruby-files` (docs/RUNBOOK.md).
- No migration.
