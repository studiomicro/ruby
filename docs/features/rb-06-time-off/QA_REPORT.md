# RB-06 Time off — QA report

**Verdict: PASS with defects** (gates clean, all 24 criteria verified; 0 Critical/High; 2 Medium, 2 Low open, none blocks merge, the two engineer-flagged ones should be fixed or accepted by the owner).

Tip tested: detached RB-06 tip rebased on main (`git diff main..HEAD`, 40 files). Fictional seed data only; local D1 and local wrangler; nothing remote.

## Commands run
- `npm ci --prefer-offline --no-audit --no-fund` and `npx svelte-kit sync`: exit 0 (real npm cache, no service).
- `npm run gates`: exit 0; check 0 errors 0 warnings (1074 files), prettier/eslint clean, vitest 54 files / 1196 tests passed (local D1 via workerd `openLocalD1`), build ok (adapter-cloudflare).
- `RUBY_E2E_PORT=4471 npm run test:e2e`: exit 0; 186 passed, 23 skipped (project-gated skips), 1.3m; real wrangler dev + local D1 (e2e-state), reset and all migrations 0001-0003 applied fresh by `scripts/reset-local.ts`.
- `npx vitest run test/qa/rb06-qa.test.ts`: exit 0; 3 passed (QA proof of the hand arithmetic below; local D1).
- `RUBY_E2E_PORT=4471 npx playwright test e2e/rb06-qa.spec.ts`: exit 0; 3 passed, 6 skipped (desktop-only probes that pass by observing the defects below).

## Hand-worked balance arithmetic (all reproduced by `test/qa/rb06-qa.test.ts`)
Annual = 24 half-days (hd).
- Mid-year joiner, start 2026-07-10: not the 1st, so July is not a full month; months = 12-7 = 5; floor(24*5/12) = 10 hd = 5 days. 2027: 24. 2025: 0. Start 2026-12-01: 1 month = 2 hd. Start 2026-12-31: 0. (Criterion 2 examples: 03-01 -> 10 months = 20 hd; 03-15 -> 9 months = 18 hd; no start -> 0, all in `timeoff.test.ts`/integration.)
- Holiday inside a span: Mon 2 - Fri 6 Nov 2026 with Wed 4 Nov a non-deducting holiday: 5 weekdays - 1 = 4 days = 8 hd. Available 10-8 = 2 (pending counts at once).
- Weekend span: Sat 7 - Mon 9 Nov: 2 weekend days skipped, Monday = 2 hd = exactly the 2 available: accepted. Next request refused ("balance"). Weekend-only and holiday-only ranges: `no_work_days`.
- Deducting holiday: Wed 11 Nov with `deducts_leave=1` counts 2 hd.
- Half day: Tue 10 Nov `am` = 1 hd; `pm` the same date accepted (no overlap); full day refused as overlap.
- Cancel after approval: approve r1 (usage -8, used 8, avail 0 once r2 pending); cancel r2 (pending) frees 2; cancel approved r1 before start: one `reversal` +8; double cancel idempotent; ledger sum = 10 -8 +8 = 10; available = 10 - 2 pending = 8.
- Year boundary: balance request 2026-12-31..2027-01-01 refused with the "split" message (`parseRequest`); a logged type (Sick) over the same dates is accepted, 2 working days = 4 hd, period 2026, no ledger row; a 2027-01-04 Annual request uses the 2027 grant (24; pending 2, available 22).

## Acceptance criteria
1. PASS - integration `access › refuses signed-out requests on every route and action`, `shows an account without an employee the empty state and refuses its requests`; layout `requireUser`; e2e shell suite.
2. PASS - `entitlements and grants › grants 10 days for a 1 March start, 9 for 15 March, 12 the year after, none without a start date`; plus QA test above.
3. PASS - unit calendar table, `requests › counts working days through the action...`, QA test (5 days over weekend, holiday skip/deduct, weekend-only refused, half day = 1 only for single date).
4. PASS - `refuses more than the balance, accepts exactly the balance; pending counts, rejected and canceled release`; QA test (exact fit accepted, then refused).
5. PASS - `race: 10 parallel requests of 6 days against 12 available yield exactly 2 pending`; guard is the single `INSERT ... SELECT ... WHERE` (repo.ts requestLeave).
6. PASS - `refuses overlapping ranges (also concurrently); adjacent, rejected and canceled do not block`; QA: am/pm same date allowed, full day refused.
7. PASS - parseRequest tests (30 days back ok, 31 refused; 366 ahead ok, 367 refused; 02-30; split on 31 Dec) + QA year-boundary test.
8. PASS - `approval › lets the manager approve; another manager, the employee, a member and a non-fallback admin get 404`; `lets HR approve anyone but themselves`; `the admin decides only when there is no manager and no other HR`. Read `canDecide`/`DECIDABLE` SQL: they agree.
9. PASS - `double approve: one wins, the other gets 409 "already decided"; usage is written once`; unique `leave_ledger_usage_uq`; QA ledger sum check.
10. PASS - `recomputes at approval: a new holiday lowers the days, a longer week that needs more balance is refused`.
11. PASS - `cancel › cancels pending any time, approved only before the start, refunds once even when doubled`; `after the start only HR may cancel, writing a leave_override audit row`; QA test.
12. PASS - `reject stores the note, the requester sees it, the ledger is untouched`.
13. PASS - `calendar and team › shows approved leave by name only...` (payload scan; `calendarMonth` selects name/dates/half_day only).
14. PASS - `team: the manager sees direct reports only, HR everyone, a skip-level manager not the report`.
15. PASS - `adjusts within bounds with an audit row; a negative adjustment below zero is refused` (ledger + `leave_adjust` in one batch, SQL guard).
16. PASS - `writes exactly one lazy grant under 20 concurrent calls, and grantYear twice adds nothing`.
17. PASS - `non-HR get the same 404 on settings`; `audits type, holiday and work-day edits; refuses a 21st type, a duplicate date and a 7-day week`; e2e holiday add/remove test. Banner for no holidays present (e2e settings).
18. PASS - `terminating an employee cancels their pending requests in the same batch; approved future leave stays`; `a refused termination cancels nothing`.
19. PASS - `keeps the ledger and audit log append-only` (triggers).
20. PASS - no `{@html}` in `src/routes/(app)/time-off` or `src/lib/ui/time-off` (grep); `time-off-ui.test.ts` renders `<script>` as text.
21. PASS - `the queue and the nav badge count exactly what the viewer may decide, and drop after a decision` (badge is `decidableCount`, capped 100).
22. PASS - `logs no reasons, names or leave types while requesting and deciding`.
23. PASS (with D1 below) - forms are plain `<form method=post>` with actions; e2e at 402x874, 440x956, 360 and desktop: no horizontal overflow, 44 px touch targets, calendar scrolls inside its own box, all controls labelled. Live preview works with JS only through the `?/preview` GET; checked by e2e. The Select hydration reset (D1) is a JS-on defect.
24. PASS - migration test `migration 0003 applies on a database with employees and seeds the four types and work_days`; fresh DB via e2e `reset-local`.

Mobile layout: PASS at 402x874, 440x956, 360x780 (e2e `time-off.spec.ts` in all projects, 0 failures; overflow and touch-target assertions).

Authorization sweep: every time-off `+page.server.ts` goes through `requireUser`/viewer checks; settings are HR-only with 404; approvals/team 404 for non-approvers; cancel of another person's request is 404 (own scope) and HR-only for team scope. Audit rows are guarded `changes() = 1`, so a lost race writes no `leave_override` row.

## Defects
- **D1 (Medium) kit Select drops a choice made before hydration.** `src/lib/ui/kit/Select.svelte:47` (`bind:value` on a prop-driven value; the page passes `value={typeId}` from `$derived`, `src/routes/(app)/time-off/+page.svelte:21,104`). Repro: throttle/delay `/_app/immutable/**`, open `/time-off`, choose "Sick" in "Leave type" before scripts load, wait for hydration: the select shows "Choose a type" again (proof: `e2e/rb06-qa.spec.ts` probe 1). A real user on a slow mobile link loses the choice; for "Part of the day" the reset target would be "Whole day", i.e. a silent change, though that select exists only after JS. It is not RB-06-only: every kit `Select` is affected. Fix in the kit (set the DOM value from the bound state on mount, or use `defaultValue`/`selected` per option). The e2e `networkidle` workaround hides it; real users can hit it. Not a data-integrity loss on the request form because the blank first option plus `required` blocks submit.
- **D2 (Medium) the owner's own requests can never be decided and nothing says so.** `src/lib/server/timeoff/permissions.ts:34-39`, `repo.ts:871-875` (`DECIDABLE`), `src/routes/(app)/time-off/approvals/+page.svelte:23`. Repro: seed has one admin who is also the only HR; sign in as that user (linked to an employee), submit leave on `/time-off`, open `/time-off/approvals`: "Nothing to decide", no hint; the request stays pending until the owner cancels it (probe 2). This follows the PRD rule (never the requester) and owner answer 8.1 (owner only HR), but the user sees no explanation. Suggest a note on the requester's pending row and in the approvals empty state when `otherHrExists` is false and no manager account exists ("No one else can approve this. Add a second HR or manager in People.") Needs an owner decision on the policy itself (second HR, or let admin self-approve with audit).
- **D3 (Low) throttle differs from PRD.** `src/lib/server/timeoff/validation.ts` `requestsPerWindow: 20` per `THROTTLE_WINDOW_MS` (10 min), PRD says 20 per hour. This is 6x looser per hour than written (pending cap 10 still bounds damage). Documented deviation; update the PRD or the constant.
- **D4 (Low) lazy grant for past periods.** `repo.ts` `ensureGrants` runs for any `period` of a request, so a late request starting in the previous year (within the 30-day window, e.g. 2025-12-20 filed on 2026-01-05) creates a full 2025 grant for someone employed since 2024 even if HR never intended one, and keeps the grant fixed if `start_on` is later corrected. Edge case; HR can reverse with an adjustment.

## Checklist
`docs/ENGINEERING_CHECKLIST.md` not walked item by item; no violation found while reading the diff (parameterised SQL, UTC arithmetic, no personal data in logs, 404 for foreign ids).

## Proof tests added (no product code touched)
- `test/qa/rb06-qa.test.ts` (3 tests, pass)
- `e2e/rb06-qa.spec.ts` (2 defect probes, desktop only; they pass while D1 and D2 exist and must be inverted when fixed)
