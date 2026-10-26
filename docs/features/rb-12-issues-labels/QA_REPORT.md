# RB-12 QA report (release 0.6.0)

**Verdict: PASS** (conditional on the version bump, see F1). No product defect found.

Tested: detached RB-12 tip 8b42129 (rebased on main), owner decisions O1-O12 at their defaults. Machine limits: `RUBY_TEST_WORKERS=2`, `RUBY_E2E_WORKERS=1`, e2e port 4571.

## Commands run

- `npm ci --prefer-offline --no-audit --no-fund` + `npx svelte-kit sync`: exit 0.
- `npm run gates` (check, lint, test, build): exit 0; prettier clean; Vitest 85 files, 1704 tests passed (local D1, no remote); build done.
- `npm run db:reset:local`: exit 0; all migrations 0000-0012 apply on a fresh local DB and the seed loads (local D1).
- Migration on existing data (scratch script on `node:sqlite`, 0000-0011 applied, seeded, then 0012): see AC5, AC20 below.
- `RUBY_E2E_PORT=4571 npm run test:e2e` (once): 301 passed, 4 failed, 67 skipped. The 4 failures were bugs in my own new spec (link text carried the key prefix; a project key too long); fixed in `e2e/rb12-qa.spec.ts`.
- `RUBY_E2E_PORT=4571 npx playwright test e2e/rb12-qa.spec.ts`: 11 passed, 18 skipped by design (data flows run on desktop only); eslint and prettier clean on the spec. Real wrangler dev server, local D1.

## Criteria

1-4 Authorization, scoping: PASS. `test/integration/issues.test.ts` (permission matrix, scopes) plus `rb12-qa` "signed-out and member are refused": signed-out GET/POST on `/issues`, `/issues/new`, `/issues/labels`, `/admin/labels` redirect/401/403; member GET and POST `/admin/labels` 403, `/issues` 200.
5 Migration keeps data: PASS (scratch run). Tasks identical, `type` = `task` for all, FTS hit identical, triggers `tasks_fts_ad/ai/au` unchanged, `integrity_check` ok, `foreign_key_check` 0 rows. Also `issues.test.ts` "migration 0012".
6 Types create/patch, CHECK: PASS (`task types` test; raw insert of `epic` rejected in scratch run).
7 Type change leaves FTS alone: PASS (scratch: `update tasks set type='bug'`, hit count still 1; Vitest FTS test).
8 Type shown: PASS. Search, My tasks (`rb12-qa` "type shows in search and My tasks"), Issues, task detail (Vitest + `issues.spec.ts`). Project list and board: Vitest/chips test only, not re-checked in a browser.
9 Team labels: PASS (create, case dup "already exists" in browser, 101st, 31 chars, 20 concurrent at 99 in Vitest).
10 Combined 10 cap: PASS (Vitest, 20 concurrent adds at 9 end at 10).
11 Deleted team label removed everywhere: PASS (Vitest).
12 Label filter across projects: PASS (`rb12-qa` team labels: bulk add to bugs in two projects, `/issues?label=` returns exactly those; unknown label dropped with 200).
13 RB-08 tests unchanged: PASS (gates).
14 Plain-text chips with Team marker: PASS (Vitest `chips and badges`).
15 Archived and deleted hidden: PASS (`rb12-qa` archived project: hidden by default, shown with `archived=1`; Vitest for deleted).
16 Filter matrix: PASS. Browser: type, priority, type+priority, multi-type, reporter=me, assignee none/me, status, project multi, created range today (inclusive) and past (empty). Vitest covers the rest and TEAM_TIME_ZONE edges.
17 Sorting and paging: PASS. Browser: priority desc, created asc, updated default; Vitest: page 3 of 120, cap 10 001; `page=abc` returns 200.
18 Invalid values dropped: PASS (`type=epic&label=nope&created_from=2026-02-30` gives 200 and "Some filters were ignored").
19 Saved views: PASS (Vitest, whitelist, cap 20, dups, deleted project).
20 saved_views survive rebuild: PASS (scratch: rows byte-equal incl. soft-deleted, indexes `saved_views_project_name_uq` and `saved_views_issues_name_uq`, CHECK rejects NULL-project list view and issues view with project, accepts valid issues view).
21 Statement budgets and plans: PASS (Vitest; engineer's noted 2 round trips, <= 10 statements / 11 with one project, accepted).
22-25 Bulk: PASS. Browser: 101 ids refused; one unknown id gives 404 and nothing changes; archived project in the set gives 409 and nothing changes. Vitest: 100 across 5 projects, positions, completed_at, notifications, label cap, milestone/project labels refused, JSON-bound ids.
26-31 Report: PASS (Vitest for all). Browser: replaying the same no-JS POST twice yields the same task (one row); double-click with JS yields one task; field errors without JS (`issues.spec.ts`).
32 No-JS flow: PASS (`issues.spec.ts` + my replay test). Project swap of labels with JS: not re-checked by me.
33 Nav: PASS (nav.test.ts; Report first in More at phone, sidebar icon on desktop in `issues.spec.ts`).
34 Release 0.5.0: SUPERSEDED, see F1.
35 Viewports: PASS at 402x874, 440x956 and 360. `/issues`, `/issues/new`, `/admin/labels`, `/issues?archived=1` with a 150-character unbroken title: no horizontal scroll; rows collapse; filter sheet opens, closes, returns focus; tap targets >= 44 px; bulk bar above the tab bar.
36 Dark mode, keyboard, screen reader: NOT RUN (manual item).
37-38 Regression and gates: PASS (gates exit 0; full e2e run otherwise green).

## Findings

- F1 (Low, release process): `package.json` and `wrangler.jsonc` `APP_VERSION` are 0.4.0 while `src/lib/content/releases/0.6.0.md` exists; the PRD said 0.5.0. This works only because of a TEMPORARY loosening in `src/lib/shared/releases.test.ts` (around lines 97-107: allows one release ahead of `package.json`). The deploy guard still refuses a mismatch. **Remove the allowance at the version bump** and set package.json and APP_VERSION to 0.6.0.
- No product defect found. Observation (not a defect): Playwright's `request.post` without `Accept: text/html` receives SvelteKit's JSON redirect (200) instead of 303; only a test-harness matter.

## Not covered

AC36 manual checks; project-label swap on the Report form with JS; real remote D1.

Proofs: `e2e/rb12-qa.spec.ts`. Nothing committed.
