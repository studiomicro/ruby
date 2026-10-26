# RB-06 Time off — PRD

Risk tier: **Large** (balance ledger and concurrent requests, date arithmetic across holidays and time zone, approval authorization, health-adjacent data; engineer + QA + red team).

Depends on: **RB-05** (employees, manager tree, `requireHr`, `hr_audit_log`, `viewerRelation`, `HR_AUDIT_ACTIONS`). Context: `docs/features/rb-05-hrm-roadmap.md` sections 4, 7, 8.

## Goal

Let employees request leave, managers (or HR) approve it, balances stay correct without spreadsheets, and everyone see who is out, without exposing why. Leave rules follow the Indonesian statutory floor (12 days annual leave) and are configurable by HR.

## Owner decisions (proposed defaults; roadmap numbering in brackets)

1. [8] Leave year = calendar year (in `TEAM_TIME_ZONE`). Annual leave 12 days = 24 half-days per year. First year accrues 1 day per full month from the start date (start on the 1st counts that month), 12 days from the next January. Employees without a `start_on` get no automatic grant (HR adjusts).
2. [9] No automatic carry-over. HR adds an audited positive adjustment for the previous year's remainder.
3. [10] Approver = direct manager's linked user; if the employee has no manager (or the manager has no account), any HR; if the requester is the would-be approver, any other HR, else any other admin. HR can approve or reject any request except their own. One step only. Owner addendum 2026-10-26 (roadmap 8.1, decision 10 addendum): while no other eligible approver exists (no manager account, no other active HR, no other active admin), the requester may approve their own request; it is stored with `self_approved = 1`, written to `hr_audit_log` as `leave_self_approve` (flagged self), shown as "Self-approved", and switches off as soon as a manager account or a second HR or admin exists.
4. [11] Holidays are entered by HR. Each has `deducts_leave` (default 0: it is a non-working day, not a leave day). No built-in list.
5. Work days default Monday to Friday, editable by HR in `app_meta` key `work_days` (comma list of ISO weekdays 1-7).
6. Seeded leave types (HR may rename, deactivate, add up to 20 total): `Annual` (balance, 24 half-days/year), `Sick` (logged, no balance), `Unpaid` (logged), `Special` (logged; marriage, bereavement, maternity and the other statutory paid leaves, with the reason field naming the case). Maternity can be 3 months: allowed by `max_request_half_days` null (unbounded) on `Special`.
7. Requests may start up to 30 days in the past (late sick leave) and end up to 366 days ahead.
8. Max 10 pending requests per employee. Reason 0-500 chars, required for `Special`.
9. A balance-type request cannot span two calendar years (submit two requests).
10. No notifications; pending count badge on "Time off" in the nav for approvers and HR.
11. Sick certificates are not uploaded in MVP (health data; Phase 2 documents vault).

## Scope

### Migration `0003_time_off.sql`

```
leave_types(
  id text PK, name text NOT NULL, kind text NOT NULL CHECK (kind IN ('balance','logged')),
  annual_half_days integer NOT NULL DEFAULT 0 CHECK (annual_half_days BETWEEN 0 AND 730),
  requires_reason integer NOT NULL DEFAULT 0, active integer NOT NULL DEFAULT 1,
  sort integer NOT NULL DEFAULT 0, created_at integer NOT NULL, updated_at integer NOT NULL)
  UNIQUE INDEX on lower(name)
  -- seed rows: ids 'lt_annual','lt_sick','lt_unpaid','lt_special'

holidays(
  id text PK, on_date text NOT NULL, name text NOT NULL,
  deducts_leave integer NOT NULL DEFAULT 0 CHECK (deducts_leave IN (0,1)),
  created_by text NOT NULL REFERENCES users(id), created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer)
  UNIQUE INDEX holidays_date_uq ON holidays(on_date) WHERE deleted_at IS NULL

leave_requests(
  id text PK, employee_id text NOT NULL REFERENCES employees(id), type_id text NOT NULL REFERENCES leave_types(id),
  start_on text NOT NULL, end_on text NOT NULL,
  half_day text NOT NULL DEFAULT 'none' CHECK (half_day IN ('none','am','pm')),  -- only when start_on = end_on
  half_days integer NOT NULL CHECK (half_days >= 1),       -- computed, recomputed on approval
  period integer NOT NULL,                                 -- calendar year of start_on
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','canceled')),
  decided_by text REFERENCES users(id), decided_at integer, decision_note text NOT NULL DEFAULT '',
  created_by text NOT NULL REFERENCES users(id), created_at integer NOT NULL, updated_at integer NOT NULL)
  INDEX (employee_id, status, start_on), INDEX (status, start_on), INDEX (start_on, end_on)

leave_ledger(      -- append-only
  id text PK, employee_id text NOT NULL REFERENCES employees(id), type_id text NOT NULL REFERENCES leave_types(id),
  period integer NOT NULL, half_days integer NOT NULL,     -- signed
  kind text NOT NULL CHECK (kind IN ('grant','usage','reversal','adjustment')),
  request_id text REFERENCES leave_requests(id), note text NOT NULL DEFAULT '',
  created_by text NOT NULL REFERENCES users(id), created_at integer NOT NULL)
  UNIQUE INDEX leave_ledger_grant_uq ON leave_ledger(employee_id, type_id, period) WHERE kind='grant'
  UNIQUE INDEX leave_ledger_usage_uq ON leave_ledger(request_id) WHERE kind='usage'
  UNIQUE INDEX leave_ledger_reversal_uq ON leave_ledger(request_id) WHERE kind='reversal'
  INDEX (employee_id, type_id, period)
  triggers: abort UPDATE and DELETE
INSERT INTO app_meta(key,value,updated_at) VALUES ('work_days','1,2,3,4,5',0)
```

Add `HR_AUDIT_ACTIONS`: `leave_adjust`, `leave_type_update`, `holiday_update`, `work_days_update`, `leave_override`. Add enums `LEAVE_KINDS`, `LEAVE_STATUSES`, `LEAVE_LEDGER_KINDS`, `HALF_DAY_PARTS`.

### Shared-file edits

- RB-05 `terminate` action: in the same batch, set the employee's `pending` requests to `canceled` (note "Employee left").
- App shell: nav link "Time off"; pending-approval badge computed in the `(app)` layout load (one indexed COUNT of pending requests the viewer may decide: for HR all pending not their own; for a manager their reports' pending).
- `src/lib/shared/enums.ts`, `schema.ts` as above. No change to `notifications`.

### Routes (`src/routes/(app)/time-off/`)

| Route | Who | Purpose |
|---|---|---|
| `+page.*` | any active user linked to an employee | My time off: balances, my requests, "Request leave" form; actions `request`, `cancel` |
| `calendar/+page.*` | any active user | Who is out, month view (`?month=YYYY-MM`) |
| `approvals/+page.*` | approvers (manager of someone, HR) | Queue of requests I may decide; actions `approve`, `reject` |
| `team/+page.*` | managers, HR | Requests and balances of my reports (HR: everyone); filter by employee, status, year |
| `settings/+page.*` | HR | Leave types, holidays, work days, balance adjustments, grant for year; actions `typeSave`, `holidaySave`, `holidayDelete`, `workDays`, `adjust`, `grantYear` |

Users without a linked employee see an empty state ("Your account is not linked to an employee record. Ask HR.") and can open the calendar only.

### Page structure

- **My time off**: balance cards per balance-type leave type for the current year (Entitled, Used, Pending, Available in days with ".5"), request table (type, dates, days, status, decided by/note, Cancel when allowed), form: type, start date, end date, half-day select (shown only when dates equal), reason. A live preview "This request uses 3 days (2 holidays and 1 weekend skipped)" via a `?/preview` GET form (no JS) or fetch (JS), computed with the server function.
- **Calendar**: month grid, each cell lists names out that day (full-day, "am", "pm"), approved requests only, any type; shows holidays with name; legend. Never shows leave type, reason or status. Pending leave is not shown. Max 366 days query window; month range clamps to 12 months back/forward.
- **Approvals**: table of pending requests I may decide, with employee, type (visible to approver), dates, days, remaining balance after approval, reason, overlap warnings (who else in the same team is out), buttons Approve / Reject (with optional note 0-500). 
- **Team**: manager sees reports; HR sees everyone; balances table and requests.
- **Settings (HR)**: leave type list (edit name, annual days, requires reason, active), holiday list per year with banner when the current year has none, work-day checkboxes, "Grant {year} entitlements" button, per-employee adjustment form (type, signed days -60..60 in 0.5 steps, note 1-200 required).

### Server modules (`src/lib/server/timeoff/`)

- `calendar.ts` (pure): `countHalfDays({startOn, endOn, halfDay, workDays, holidays})` → `{halfDays, skipped:{weekends,holidays}}`; holidays with `deducts_leave=0` are skipped; holidays with `deducts_leave=1` count as leave days; `splitByYear`; `isoWeekday(dateStr)`; all computed with `Date.UTC`, no local time zone.
- `accrual.ts` (pure): `annualEntitlement({startOn, period, annualHalfDays})` (first year prorated 1 day per full month, minimum 0; later years full; before start year 0), `statutoryNote`.
- `repo.ts`: `balances(db, employeeId, period)`, `listMyRequests`, `listApprovalQueue(db, actor)`, `requestLeave`, `decide`, `cancel`, `adjust`, `grantYear`, `ensureGrant` (lazy per-employee current-year grant), holiday and type CRUD, `calendarMonth`.
- `permissions.ts`: `canDecide(actor, request, employee, managerUserId)`, `canCancel(actor, request, today)`, `approverFor(employee)`.
- `validation.ts`: `LEAVE_LIMITS`.

### Validation (`LEAVE_LIMITS`)

- `type_id` an active leave type. `start_on`, `end_on`: `YYYY-MM-DD` round-tripping `Date.UTC`; `end_on >= start_on`; `start_on >= today - 30 days`; `end_on <= today + 366 days`; total span <= 366 days. `half_day` in `none|am|pm`, and not `none` only if `start_on == end_on`.
- Computed `half_days >= 1` else "That range has no working days". Balance type: `start_on` and `end_on` in the same calendar year; `half_days <= available` (see concurrency).
- `reason` 0-500, required when the type has `requires_reason`. `decision_note` 0-500. Adjustment `half_days` integer -120..120, non-zero, note 1-200. Holiday: date 2000-01-01..2100-12-31, name 1-80, at most 40 live per year. Type: name 1-40, annual_half_days 0-730, at most 20 types.
- Pending requests per employee <= 10.
- `work_days`: non-empty subset of 1-7, at most 6 (a 7-day week is refused).

### Authorization per action

| Action | Rule |
|---|---|
| View my page, create request | `requireUser`, user linked to a live, active employee; requests only for self |
| Cancel | requester while `pending`; requester while `approved` and `start_on > today`; HR any time (audited `leave_override`) |
| Approve / reject | `canDecide`: actor is the employee's manager's user, or actor is HR (not the requester), or admin when the employee has no manager and no HR other than the requester exists; never the requester; request must be `pending` |
| Team page | HR all; manager their direct reports only |
| Calendar | any active user (approved only, no type, no reason) |
| Settings, adjust, grant | HR |

Every action re-reads request, employee and manager server-side. Wrong-employee ids and non-approvers get 404 (not 403) to avoid leaking existence.

### Concurrency

- **Request (balance type)**: single guarded statement:
  `INSERT INTO leave_requests (...) SELECT ... WHERE NOT EXISTS (overlap with employee's pending/approved ranges) AND (SELECT count(*) FROM leave_requests WHERE employee_id=:e AND status='pending') < 10 AND (SELECT coalesce(sum(half_days),0) FROM leave_ledger WHERE employee_id=:e AND type_id=:t AND period=:p) - (SELECT coalesce(sum(half_days),0) FROM leave_requests WHERE employee_id=:e AND type_id=:t AND period=:p AND status='pending') >= :hd`.
  `changes = 0` → re-read to report overlap, balance or pending-limit. Two simultaneous requests that together exceed the balance: the second sees the first as pending and fails.
  Logged types skip the balance clause but keep overlap and pending-limit.
- **Lazy grant**: before computing balances, `ensureGrant` runs `INSERT … SELECT … WHERE NOT EXISTS (grant for employee/type/period)`; the partial unique index `leave_ledger_grant_uq` makes concurrent calls safe (a duplicate is swallowed by `OR IGNORE`). "Grant {year}" by HR runs the same insert for all active employees with a start date, in batches of at most 50 statements.
- **Approve** in one `db.batch`: (1) `UPDATE leave_requests SET status='approved', decided_by, decided_at, half_days=:recomputed, updated_at=max(:now,:expected+1) WHERE id AND status='pending' AND updated_at=:expected AND (type is logged OR available_excluding_this >= :recomputed)`; (2) `INSERT INTO leave_ledger (kind 'usage', half_days = -:recomputed, request_id) SELECT … WHERE EXISTS (SELECT 1 FROM leave_requests WHERE id=:id AND status='approved' AND updated_at=:newUpdatedAt)` for balance types; (3) audit row only for HR overrides and adjustments (routine manager approvals are not HR audit events; they are visible in the request row). Unique `leave_ledger_usage_uq` makes a double approval impossible. 0 changes → re-read: already decided → 409 "Already decided by X"; balance short → 409 with figures.
- **Reject**: guarded `status='pending'`.
- **Cancel approved**: batch (1) `UPDATE … SET status='canceled' WHERE id AND status='approved' AND start_on > :today`; (2) ledger `reversal` `+half_days` `WHERE EXISTS (request canceled)`; unique `leave_ledger_reversal_uq` blocks double refunds. HR override skips the `start_on` condition and writes an audit row in the same batch.
- **Adjust**: ledger insert (kind `adjustment`) + audit row in one batch; negative adjustment refused if it would make the period balance below 0 (guard in SQL).
- **Approver and holiday edits**: holiday insert/delete after requests exist does not alter stored `half_days` of approved requests; pending requests are recomputed at approval.
- **Terminate (RB-05)**: pending → canceled in the same batch, guarded by `status='pending'`.
- Time: "today" always from `todayIn(TEAM_TIME_ZONE, now)`.

### States

Loading skeletons; empty balances ("No leave types configured" for HR); no requests "No requests yet"; calendar empty month "Nobody is out"; form errors inline; 409 banners ("This request was already decided", "Not enough balance: 1.5 days available", "You already have leave on those dates"); no holidays for the current year banner for HR ("No holidays entered for 2026"); no linked employee message; success only after server confirmation.

## Acceptance criteria

1. Signed-out and deactivated users are refused on every route and action; a user without an employee link cannot request leave.
2. Annual leave: 12 days entitlement (24 half-days). An employee who started on 2026-03-01 gets 10 days for 2026 (March-December), 12 for 2027; one who started 2026-03-15 gets 9; one with no start date gets none.
3. Day counting: a Monday-Friday request over a weekend counts 5; a public holiday inside the range with `deducts_leave=0` is not counted; with `deducts_leave=1` it is counted; a range of only weekend/holiday days is rejected; a half-day counts 1 half-day and is allowed only for a single date.
4. A balance request greater than available is refused; exactly equal is accepted; pending requests reduce availability immediately; rejected/canceled ones release it.
5. 10 parallel requests of 6 days each against 12 available days yield exactly 2 pending, 8 refusals (integration race).
6. Overlapping pending/approved ranges for the same employee are refused (concurrent test); adjacent ranges are accepted; `canceled` and `rejected` do not block.
7. Date rules: start 31 days ago refused, 30 days ago accepted; end 367 days ahead refused; balance request across 31 Dec / 1 Jan refused with the "split" message; `2026-02-30` refused.
8. Approval: the employee's manager can approve; another manager, the employee, a plain member, and an admin who is not an eligible fallback get 404 and nothing changes; HR can approve anyone except their own request; HR requester approved by another HR; employee without manager is decided by HR.
9. Approve writes a `usage` ledger entry of `-half_days` exactly once; double click / two tabs → one wins, the other 409 "Already decided"; the ledger sum equals entitled minus approved usage.
10. Approve recomputes days against current holidays and work days; if the result needs more than the available balance, it is refused with the figures.
11. Cancel: requester cancels pending any time; cancels approved only before `start_on`; after the start only HR (writes `leave_override` audit); canceling approved writes a `reversal` entry exactly once and restores the balance; double cancel idempotent.
12. Reject stores the note; the requester sees the decision and note; a rejected request does not change the ledger.
13. Calendar shows approved leave for all users with names only; it never exposes leave type, reason, pending or rejected requests (assert on payload for a plain member).
14. Team page: manager sees only direct reports; HR sees all; skip-level sees none.
15. HR adjustment: signed value within -120..120, non-zero, note required, writes ledger and `leave_adjust` audit atomically; a negative adjustment below zero balance is refused.
16. `grantYear` is idempotent (running twice adds nothing); lazy grant on first visit creates exactly one grant row under concurrent calls.
17. Settings: only HR; non-HR get 404; type, holiday (unique date per live row) and work-day edits write audit rows; 21st type refused; 7-day work week refused; banner appears when the current year has no holiday.
18. Terminating an employee cancels their pending requests in the same batch; approved future leave stays and HR can cancel it.
19. Ledger and audit tables are append-only (raw UPDATE/DELETE aborted by trigger).
20. Reason `<script>` and Markdown are shown as plain text; reason, note and type names are never rendered with `{@html}`.
21. Nav badge counts exactly the pending requests the viewer may decide and updates after a decision.
22. Logs contain no reasons, names or leave types.
23. All forms work with JS disabled; calendar usable at 360 px; every control labelled.
24. `npm run check`, lint, tests pass; migration `0003_time_off.sql` applies on a database with employees and seeds the four types and `work_days`.

## Test plan

Unit: `countHalfDays` table (weekend, holiday, deducting holiday, half-day, single day, year boundary, leap day, 6-day week); `annualEntitlement` table; date validators; `canDecide` matrix; `canCancel` table.
Integration (`openLocalD1`, `fakeEvent`, `test/helpers/seed-hr.ts` from RB-05 plus `seed-leave.ts`): balance race; overlap race; double approve; double cancel; approve with changed holidays; lazy grant race; grantYear idempotence; every authorization row with each viewer role; calendar payload scan; terminate hook; adjustment guard; trigger tests.
Manual: phone layout, no-JS request/approve flow, month calendar with 20 people out.

## Out of scope

E-mail and in-app notifications (Phase 2 table rebuild); multi-step approval chains; delegation when a manager is away; leave policies per employee group or seniority tiers; automatic carry-over and expiry; long-leave (cuti besar) rules; accrual by anniversary; medical certificate upload; unpaid-leave effect on pay; overtime and comp time; attendance check-in; public-holiday auto import; calendar feeds (ICS); half-day on multi-day boundaries; time-of-day leave (hours); reports and CSV export (Phase 2).

## Architecture notes

Reuse RB-05 `requireHr`, `viewerRelation`, `auditStatement`, `employees.manager_id`, `todayIn`/`isValidDueOn`-style date helpers (`src/lib/server/tasks/dates.ts`), throttle (`leave-request` 20 per 10 minutes per user: the throttle module's longest window is 10 minutes; owner-accepted QA D3), `newId`, `errorLabel`. New trees: `src/lib/server/timeoff/**`, `src/routes/(app)/time-off/**`, `test/helpers/seed-leave.ts`. D1's 100-parameter limit: pass holiday and employee id lists as one JSON parameter with `json_each`.

## Prerequisites

RB-05 merged. `TEAM_TIME_ZONE` set (already). HR enters the year's holidays after deploy (owner action; the banner reminds). No new secrets or bindings.

## Schema additions

Migration `0003_time_off.sql` as above.

## Tracker impact

New `docs/TASKS.md` item "RB-06 Time off" (Claude) and "Enter {year} public holidays" (You). `docs/ACCEPTANCE.md`: ledger integrity (Automated), approval authorization (Automated), calendar privacy (Automated).
