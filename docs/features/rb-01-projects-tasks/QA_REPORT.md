# RB-01 Projects and tasks — QA report

**Verdict: PASS** (no Critical/High/Medium defects; 2 Low findings, 1 pre-existing flake note)

## Commands run
- `npm ci --prefer-offline --no-audit --no-fund && npx svelte-kit sync`: exit 0.
- `npm run gates`: exit 0; svelte-check 860 files 0 errors 0 warnings; lint clean; vitest 21 files / 450 tests passed; build ok (local D1/fixtures, no real service).
- `RUBY_E2E_PORT=4341 npm run test:e2e` run 1: exit 1; 39 passed, 5 skipped, 1 failed (`shell.spec.ts:67` More sheet ... Escape, iphone-402; sheet stayed visible after Escape). Local wrangler dev + local D1.
- `RUBY_E2E_PORT=4341 npm run test:e2e` run 2: exit 0; 40 passed, 5 skipped.
- `RUBY_E2E_PORT=4351 npx playwright test e2e/shell.spec.ts` on `main` (detached worktree) x3: exit 0 each, 19 passed; More-sheet test passed on all phone projects. Only the shell spec was run on main (main has no other specs), so load is lower than the full branch run; flake not reproduced on main, reproduced 1 of 2 on the branch. It is RB-00 code (Escape handler vs. hydration/load), not touched by RB-01 (`git diff main..HEAD` has no shell files). Treat as pre-existing, load-sensitive.
- `RUBY_E2E_PORT=4341 npx playwright test -c test/qa/playwright.qa.config.ts` x2 (QA proofs, 4 projects): exit 0 both; 16 passed, 9 skipped (desktop-only/phone-only tests). Local wrangler dev + local D1.
- Migration check: `git diff main..HEAD -- migrations` is empty (no migration added), so `db:reset:local` not required (the e2e server start runs reset+migrate+seed on every start, exit 0).

## Criteria
1. Auth: PASS. Integration `access` (all 17 loads/actions 401 signed out); QA pw `access`: signed-out /projects, /projects/new, /my-tasks, project, task redirect to /login, raw POSTs refused; seeded member disabled by admin gets /login on next request and POST refused (re-enabled in finally).
2. Key rules: PASS. Integration `creates OPS from "ops"...`; QA pw `routes`: A, 1AB, A-B, ÄB, new (reserved) show field errors in the browser; 11-char key refused server-side by raw POST (the browser input truncates to 10 via maxlength, so the UI alone cannot show it).
3. Key immutable: PASS. Integration `settings: the key cannot change`; QA raw POST `key=HACK` to `?/update`: `/projects/HACK` 404.
4. Numbering: PASS. `numbers consecutively...`, `20 concurrent creates get 1..20`.
5. Archived/missing create: PASS. `an archived or missing project inserts nothing`, route test `create: ... archived 409`.
6. Validation: PASS. tasks.test.ts `boundaries`, `missing fields keep the fallback`; route `create: validation boundaries`.
7. Stale update 409 + keep mine: PASS. repo `stale version...`, route `update: a stale version answers 409`.
8. completed_at: PASS. `done sets it, done→canceled keeps it, reopening clears it`; QA pw drag/status change.
9. Board columns/order/100 cap: PASS. `board: six columns in order, 100 cards per column and the full count`; e2e board spec (6 columns).
10. Drag-and-drop: PASS. Mouse drag with Playwright mouse events (desktop): card three dragged above card one landed first, persisted after reload; card dragged to the In progress column persisted after reload (`test/qa/rb01.pw.ts` mouse drag). Keyboard drag in e2e. Position between/renumber: `between two cards lands strictly between`, `renumbers a column whose gap is below 1e-6`. Not tested: touch drag on a real device; drag to the far Done column (offscreen at 1280 px, used In progress instead).
11. No-JS move: PASS. QA pw (`javaScriptEnabled:false`): details/summary opens, select In progress + top, submit, board re-renders with card in the new column.
12. Foreign afterTaskId: PASS. `foreign anchors go to the bottom`, route `move (no-JS form)`; QA raw POSTs with nil uuid, `not-a-uuid`, SQL text: all < 500.
13. Notification matrix: PASS. `assigned notifications` x3 tests.
14. Atomicity: PASS. `a refused (stale) write leaves no notification`.
15. Filters/pagination: PASS. `filters: OR within one, AND across`, route `list load`.
16. Overdue: PASS. `dueBucket`, `my tasks load uses the team date`; QA pw: open task due 2001-01-01 shows `time.due.overdue`; after status done it does not.
17. My tasks: PASS. `my tasks: only mine, live, grouped...`; e2e `my tasks fits the screen`.
18. Soft delete: PASS. `numbers are not reused after a soft delete`, route `detail: ... deleted numbers are 404`, delete tests.
19. Delete 403: PASS. route `delete: 403 for a member who is not creator or lead`.
20. Archived freeze: PASS. route `archived project: patch, update, move and delete are refused server-side; reads work`; repo `archived project and deleted task refuse every write`.
21. Markdown inert: PASS. route `a description with <script> and a javascript: link renders inert`; QA pw in browser: script/img/onerror tags stay escaped text, `window.__pwn` undefined, no `a[href^=javascript]` in the page.
22. Routes: PASS. QA pw: `/projects/<lowercase>` redirects to uppercase; tasks/0, abc, 99999999999, 01, -1 and unknown key are 404.
23. No-JS / labels / keyboard: PASS. QA pw label audit on 8 pages x 4 viewports: every visible control has an accessible name, no horizontal overflow; keyboard drag e2e passes; no-JS move form and `?status=` preset verified (in_review). Other forms are plain POST forms with `use:enhance`; only the move form and the page create-project flow were exercised with JS off.
24. Quality gates: PASS. No `any`, no `@html` outside the markdown component, each-blocks keyed by id, no migration; gates clean.

Mobile layouts at 402x874, 440x956, 360 (e2e `projects.spec.ts` + QA label/overflow audit + screenshot review of the 360 board): no overflow, board snaps per column, fields stack under the description.

## Findings
- **F1 Low** `src/routes/(app)/projects/[key]/tasks/[number]/+page.svelte` (`.crumb`): breadcrumb link is 21 px tall on phones; checklist asks 44 px on coarse pointers. Repro: open any task at 402 px, measure `a.crumb`.
- **F2 Low** `src/lib/ui/tasks/Board.svelte` card `a.title`: 19 px tall tap target on phones (the handle and the Move summary are 44 px; the title link is not). Repro: board at 360 px.
- **F3 Info** RB-00 `e2e/shell.spec.ts:67` "More sheet ... Escape" flakes under the full parallel e2e run (1 of 2 runs on this branch, 0 of 3 on main shell-only). Not caused by RB-01.
- **F4 Info** The key input's maxlength=10 truncates a pasted 11-character key to a valid 10-character key and creates it silently (server rejects 11 chars when posted directly). Consider no truncation or a visible hint; not a PRD failure.

## Proof tests
`test/qa/rb01.pw.ts`, `test/qa/playwright.qa.config.ts` (run: `RUBY_E2E_PORT=4341 npx playwright test -c test/qa/playwright.qa.config.ts`). Not committed. Leaves `SMALLTARGETS`/`BADKEY` console.log lines (diagnostic).
