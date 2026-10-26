# RB-08 QA report

**Verdict: PASS**

Tip: detached at the RB-08 tip on main (with RB-03/04/05). Migration is `migrations/0010_pm_plus.sql` (PRD says 0005; same SQL, renumbered on top of 0002_hr_core).

## Commands run
- `npm ci --prefer-offline --no-audit --no-fund` + `npx svelte-kit sync`: exit 0, local only.
- `npm run db:reset:local`: exit 0, 0000, 0001, 0002, 0010 apply on a fresh local D1 (miniflare), seeds the demo accounts.
- `npm run gates`: exit 0; check (svelte-check --fail-on-warnings) clean, lint clean, `Test Files 53 passed (53)`, `Tests 1171 passed (1171)`, build done (adapter-cloudflare). Local fixtures and in-memory D1.
- `RUBY_E2E_PORT=4441 npm run test:e2e`: exit 0, `175 passed`, `26 skipped` (pre-existing per-project skips), 4 projects (iphone-402 = 402x874, iphone-440 = 440x956, phone-360, desktop), wrangler dev with local D1.
- `RUBY_E2E_PORT=4441 npx playwright test e2e/rb08-qa.spec.ts`: `2 passed` (setup + QA probe), local wrangler dev.
- `npx vitest run test/integration/pm.test.ts`: `Tests 31 passed (31)`, in-memory D1 (openLocalD1).

## Checked criteria
1. Auth: PASS. `test/integration/pm.test.ts` "every new load and action refuses a signed-out request with 401 and writes nothing"; my `e2e/rb08-qa.spec.ts` raw HTTP: signed-out GET of project, settings, milestone, task pages give 303; POST of 8 new actions and DELETE of `views/[id]` give 303/401/403; signed-in missing and malformed milestone ids both 404. Deactivated user: `rb01-qa.spec.ts` access test, still green.
2. Labels: PASS. "case-insensitive per project, 30 per project, delete frees the name", "20 concurrent creates against 29 live labels: exactly one succeeds", "route refuses 31-char name, colour outside enum, duplicate".
3. 10 labels per task / foreign / deleted label: PASS. "a task holds at most 10; a deleted or foreign label is refused with nothing changed".
4. Checklist: PASS. "add, tick, untick, edit, move, delete; progress 3/7 everywhere", "51st step refused; 20 concurrent adds against 49: exactly one", "ticking does not change tasks.updated_at / no 409"; e2e checklist add and tick on all 4 viewports.
5. Milestones: PASS. Manager-only matrix (member 403, nothing changes), "51st refused; closed, foreign, deleted cannot receive tasks; delete clears links", "progress is done over non-canceled total".
6. Columns: PASS. "rename shows on the board only; status stays; hiding a column with tasks refused", "hide vs concurrent move" race; e2e board shows "QA" heading, "1 hidden column.", 5 columns.
7. WIP: PASS. "4 tasks over limit 3, 5th move allowed; 0, 201, 2.5 refused"; e2e `.wip.over` contains "Over limit".
8. Filters: PASS. "label (OR) and milestone (incl. none) compose with RB-01 filters; invalid ids dropped".
9. Saved views: PASS. "save from filters; only whitelisted keys stored; open restores; others get 404", "20 concurrent saves against 19: exactly one"; unit `canonicalizeQuery` tests (500-char cap, unknown keys, injection).
10. Bulk: PASS. 100 tasks in one request, 101 refused, outside/deleted id gives 404 and nothing written, archived refused, notification matrix (never self, only changed), 10-label cap, completed_at set and cleared.
11. Bulk ordering: PASS. "appends to the bottom of the column in ascending number order".
12. RB-01 unchanged: PASS. All RB-01 unit, integration, security and e2e suites green; query-count test "same number of D1 statements for 5 and 120 tasks" for list and board.
13. FTS unchanged: PASS. "task search is unchanged ... tombstones stay hidden".
14. Archived project: PASS. "every new mutation is refused server-side; reads still work".
15. Plain text, no `{@html}`: PASS. `git diff main..HEAD -- src | grep '{@html'` returns nothing; "user text is stored as cleaned plain text and rendered escaped".
16. Keyboard, no-JS, 360 px, colour not sole signal: PASS. e2e: no-JS bulk edit and checklist step (desktop, JS disabled); bulk by touch (`.tap()` on 402, 440 and 360 phone projects, 44px tap-target assertions, no horizontal overflow); settings, board (scrolls inside its box, `scrollX` stays 0) and task page fit at 402/440/360; WIP chip and label chips carry text ("Over limit").
17. Migration: PASS. `db:reset:local` applies 0000-0002 plus 0010; test "migration 0010 applies on a database with existing tasks without data loss; milestone_id NULL; FTS triggers kept". `0010` is additive (no tasks table rebuild), so the tasks_fts triggers are untouched.
18. check, lint, tests: PASS (gates exit 0).

## Checklist (docs/ENGINEERING_CHECKLIST.md)
No violation found: id lists bound as one JSON param (100-param regression test with 300-task board and 100-id bulk), every new load, action and the views DELETE route start with `requireUser`, timestamps are ms integers, guarded single-statement writes proven by concurrency tests.

## Findings
None blocking. Notes (info):
- PRD names `0005_pm_plus.sql`; shipped file is `migrations/0010_pm_plus.sql` (orchestrator-approved renumber).
- Not verified here: dark-mode chip colours by eye (CSS variables only inspected via test/css.test.ts in gates); real remote D1.
- Proof test added: `e2e/rb08-qa.spec.ts` (raw HTTP refusal probe).
