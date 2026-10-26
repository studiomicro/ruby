---
description: Resume a RUBY session: read the tracker, rerun the gates, report state, continue at the next open Claude item.
---

Extra instruction (optional): $ARGUMENTS

1. Read `docs/TASKS.md` fully (status summary, the `To do` list). Skim the last 30 lines of `docs/HISTORY.md` and `git log --oneline -15`; run `git status --short`.
2. If `package.json` exists, run `npm run gates` and quote only the summary lines. If any step fails, that failure is the first task; do not start feature work on a red tree.
3. Report to the user in this order: gate results; uncommitted changes (if any); commits not yet deployed; the first three open `**Claude**` items; the `**You**` items that block them.
4. Continue with the first open `**Claude**` item that is not blocked: `/build-feature` for new behaviour, `/fix-bug` for defects, `/verify` for verification-only items. If every Claude item is blocked on a `**You**` item, stop and list exactly what the owner must provide (variable name, account step, decision).
