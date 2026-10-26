# RB-01 Projects and tasks — summary

**Status: complete** (2026-10-26).

Projects with keys and leads, numbered tasks, list and board views (mouse, keyboard and no-JS moves), task detail
with conflict-safe edits, My tasks, and assignment notifications.

- QA: PASS (Lows: phone tap targets, pasted key truncation — fixed in cycle 2).
- Red team: PASS (Lows: forged mention names, reassign notification spam, archived-board renumber — fixed; FTS
  tombstones covered by RB-02 search filtering live rows).
- Shared change: `e2e/shell.spec.ts` waits for hydration before pressing Escape (flaky test fix).
- No migration.
