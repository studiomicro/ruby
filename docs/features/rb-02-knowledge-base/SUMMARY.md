# RB-02 Knowledge base — summary

**Status: complete** (2026-10-26).

Pages in trees (team-wide and per project), Markdown editing with preview, revisions with restore and conflict
handling, move and subtree delete, and full-text search over pages and tasks at `/search`.

- QA: PASS (L1 search burst, L2 body length counting — both fixed in cycle 2).
- Red team: FAIL (M1: a member could delete another person's page by moving it under their own page and deleting
  that) → cycle 2 → re-check PASS. L4 (render cost of pathological Markdown) accepted as info.
- Shared change: `src/lib/server/auth/throttle.ts` gained a one-minute window (`overUserMinuteLimit`); RB-00 budgets
  re-checked unchanged.
- No migration.
