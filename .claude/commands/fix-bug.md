---
description: Diagnoses a bug from evidence, fixes it at the narrowest layer with a regression test, then runs QA and red-team once. Never commits; use /ship.
---

Bug report: $ARGUMENTS

Derive a kebab-case `<slug>` prefixed `fix-` (e.g. `fix-search-deleted-page`).

1. Reproduce first, without editing source. Read the relevant modules under `src/lib/server`, `src/routes`; run the narrowest existing test (`npx vitest run <file>`) or a local `wrangler dev` request that shows the failure. If the bug depends on Cloudflare Access or the deployed Worker and you cannot reach it, say so and reproduce with a local test; never fabricate output.
2. Write `docs/features/<slug>/PRD.md` yourself (no cto-strategist for bugs): **Symptom**, **Root cause** with `file:line`, **Fix scope**, **Acceptance criteria** (the failing scenario as "given/when/then", plus "existing tests still pass").
3. Dispatch `senior-software-engineer` with the PRD. It must add a regression test that fails before the fix and passes after, in the lowest layer that shows the bug, and touch only the layer that owns the cause.
4. Dispatch `qa-tester`, then (on PASS) `red-team-pentester`, as in `/build-feature` (risk tier and branching rules from its steps 0a and 0b). At most 2 fix cycles for a bug.
5. Update trackers as in `/build-feature` step 7 (HISTORY bullet prefixed **Fix:**). If the bug was visible in production, add a `**Claude**` To do item "verify in production after next deploy".
6. Report: cause, fix, regression test name, checks run with result lines. Do not commit.
