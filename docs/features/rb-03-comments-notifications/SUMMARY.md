# RB-03 Comments, @mentions and notifications — summary

**Status: complete** (2026-10-26).

Comments on tasks and pages with @mentions, an in-app notification inbox and the unread badge.

- QA: PASS (F1: the phone tab bar hid focused buttons — fixed app-wide with `scroll-padding`).
- Red team: FAIL (M1: inbox kept excerpts of comments on deleted tasks/pages/projects; L1 repeat mention
  notifications; L2 unthrottled mention search) → cycle 2 → re-check PASS.
- Shared changes: `src/app.css` (scroll padding), `throttle.ts` (`mention-search` scope), `mentionNames`
  (`markDeactivated` option), `(app)/+layout.server.ts` (unread badge).
- No migration.
