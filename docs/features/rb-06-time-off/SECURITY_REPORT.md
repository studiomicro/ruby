# RB-06 Time off — Security report (red team, cycle 1)

**Verdict: PASS.** No medium or high findings. Six low findings and three info notes are listed below so they are tracked.

Scope: `git diff main..HEAD` in the worktree detached at the RB-06 tip (`2f84c44`, rebased on main with RB-05 live).
That covers `src/lib/server/timeoff/**`, `/time-off/**` (mine, calendar, approvals, team, settings), migration
`0003_time_off.sql`, the RB-05 `writeEmployee`/`terminate` hook, the `(app)` layout badge and the `leave-request`
throttle scope. The diff was also checked against `docs/ENGINEERING_CHECKLIST.md`.

Proof tests (all pass):

- `test/security/rb06-pure.test.ts` (40 tests): the approval and cancel matrices, day counting (leap day, New Year,
  holidays, half days, 6-day week), proration, date fuzzing in the request parser, the settings parsers, the throttle
  merge, CSRF on every time-off action, and static scans (no `{@html}`, no logging, `requireViewer` everywhere).
- `test/security/rb06-d1.test.ts` (24 tests, local D1): the authorization matrix through the actions, IDOR, HR-only
  settings, races (approve against cancel, parallel cancels, cross-type overlap, adjust against approve), ledger
  tampering, calendar, page and badge payloads, hook-level CSRF and cache headers, throttle, date tampering through the
  action, and the terminate hook.
- `test/security/rb06-owner-d1.test.ts` (2 tests, fresh D1): the production cast, where the owner is the only admin and
  the only HR user.

Command results:

- `npx vitest run test/security/rb06-pure.test.ts`: 40 passed.
- `npx vitest run test/security/rb06-d1.test.ts`: 24 passed.
- `npx vitest run test/security/rb06-owner-d1.test.ts`: 2 passed.
- `npx eslint test/security/rb06-*.test.ts`: clean.
- `npm test`: `Test Files 57 passed (57)`, `Tests 1262 passed (1262)`.

The tests named "PROOF" pin how a finding behaves today. Flip each one when its finding is fixed.

## Findings

### L1 (low): nobody can decide the owner's own leave, and the UI does not say so

This is the engineer's note.

- **Where:** `src/lib/server/timeoff/permissions.ts:26-40` (`approverFor` returns `'admin'` even when the only admin is
  the requester) and `src/routes/(app)/time-off/+page.svelte`, which shows no hint.
- **Scenario:** under owner answer 8.1 the owner is the only HR user and the only admin. The owner has no manager. When
  the owner requests leave, `approverFor` returns `admin`. `canDecide` refuses the requester, and no other admin exists.
  The request therefore stays pending forever:
  - It holds the balance as "Pending".
  - It counts toward the 10-pending limit.
  - It appears in no queue and no badge (`decidableCount` is 0 for every user).
  - The owner sees only "pending".
- **Repro:** `rb06-owner-d1.test.ts` › "PROOF L1".
- **Why low:** nothing leaks and nothing is bypassed. This is a dead end for availability and usability, and the owner
  can cancel the request.
- **Safest fix:** keep self-approval impossible. Make the dead end visible and leave the resolution to a second person.
  1. Make `approverFor` return `'none'` when there is no manager account, no other HR user and no active admin other
     than the requester. Compute this in `getRequest` (`EXISTS` an active admin `<> r.created_by`) and expose it on
     "My time off" as `approverMissing`.
  2. On the request form and on each pending row, show: "Nobody can approve your requests yet. Ask an admin to grant HR
     to a second person, or set a manager on your employee record." Optionally block a balance-type submission while
     no approver exists, so days are not held in limbo.
  3. Add a settings banner for HR on the same condition.
  4. Do **not** add a self-approve or auto-approve path. That would undo the "never the requester" rule. If the owner
     wants to record leave taken meanwhile, the existing audited negative `adjust` already covers it. L2 notes the
     separation-of-duties gap in that path.

### L2 (low): HR acts on their own balance (no separation of duties outside approval)

- **Where:**
  - `src/routes/(app)/time-off/settings/+page.server.ts:159-164`: `adjust` has no check against the viewer's own
    employee.
  - `src/lib/server/timeoff/permissions.ts:61`: `canCancel` returns `'override'` for HR on their own started leave.
  - `src/lib/server/timeoff/route.ts:28-33`: the "own" scope accepts that override.
- **Scenario:** the PRD forbids HR to approve their own request, but an HR user can still change their own balance:
  - They can add up to +60 days to their own balance with `adjust`.
  - After another approver has approved their leave and the leave has started, they can cancel it themselves. That
    writes a `reversal` and returns the days already taken.
  - Both actions are audited (`leave_adjust`, `leave_override`, with the actor equal to the subject).
- **Repro:** `rb06-d1.test.ts` › "PROOF L2", and `rb06-pure.test.ts` › "PROOF L2".
- **Why low:** today the owner is the only HR user, and every write is audited. The risk grows when a second HR user is
  granted.
- **Fix:** refuse `adjust` when `employeeId === viewer.ownEmployeeId`, and refuse the override-cancel when
  `request.createdBy === viewer.userId` (in `canCancel`, the "own" branch should never fall through to `override`).
  Another HR user or an admin then acts instead. Alternatively, keep both actions but flag self-actions in `/hr/audit`.

### L3 (low): the former account keeps cancel rights after HR relinks an employee record

- **Where:** `src/lib/server/timeoff/route.ts:28-29`. Ownership is `request.createdBy === viewer.userId`, not the
  record's current `user_id`.
- **Scenario:**
  1. HR unlinks account A from an employee record and links account B to it.
  2. A, which now has no employee record, can still cancel the record's pending and future approved requests. Cancelling
     an approved request writes a `reversal`.
  3. B sees the earlier requests, reasons included, but cannot cancel them.
- **Repro:** `rb06-d1.test.ts` › "PROOF L3".
- **Fix:** in the "own" scope, require that the request's employee is the viewer's current `ownEmployeeId` (or both
  that and `createdBy`). Optionally hide the reasons of requests made by another account.

### L4 (low): leave can be requested before the employee's start date

- **Where:** `src/lib/server/timeoff/repo.ts:595-596`. The guard checks only that the employee is live, active and
  linked; it never compares `start_on` with the employee's `start_on`. Related: `accrual.ts`/`ensureGrants` grant the
  whole first-year prorated amount as soon as the year is touched.
- **Scenario:** a new hire whose account is linked before day one can book leave dated before employment begins. In the
  start year they can spend the full prorated grant up front.
- **Repro:** `rb06-d1.test.ts` › "PROOF L4".
- **Fix:** add `AND (e.start_on IS NULL OR e.start_on <= ?4)` to the INSERT guard and to the reason query, with the
  message "Leave can start on or after your start date." Up-front proration is policy, so it is left to the owner.

### L5 (low): authorization is not re-asserted inside the decision batch (TOCTOU)

- **Where:** `src/lib/server/timeoff/repo.ts:684-767`. `canDecide` runs on the row read at line 684. The guarded
  `UPDATE` in the batch at line 767 checks `status` and `updated_at` but not the approver relation. In between, the
  code awaits `countRange` and `ensureGrants` (several D1 round trips).
- **Scenario:** HR moves the report to another manager, or revokes `is_hr`, while the old manager's approve request is in
  flight. The approval still lands, signed by the former manager.
- **Repro:** `rb06-d1.test.ts` › "PROOF L5", which injects the manager change just before the batch.
- **Why low:** the window is milliseconds wide, and it needs an HR action at the same moment. The decision is visible on
  the request row.
- **Fix:** add the authorization to the `UPDATE … WHERE` in the same form as `DECIDABLE`. That is, require one of:
  - the employee's live, active manager's active account equals `?actor`;
  - the actor `is_hr = 1 AND status = 'active'`;
  - the admin-fallback clause.

  Also add `r.created_by <> ?actor`. Apply the same change to the reject `UPDATE`.

### L6 (low): GET loads write ledger rows

- **Where:**
  - `src/routes/(app)/time-off/team/+page.server.ts:35`: `ensureGrants` for any `?year=` up to next year, for every
    visible employee.
  - "My time off" load (`balances` → `ensureGrants`).
  - `listApprovalQueue`.
- **Scenario:** the checklist says "no state change on GET". The lazy grant is PRD-sanctioned, idempotent, deterministic
  and protected by `leave_ledger_grant_uq`, so a cross-site GET can only create a grant that would be created anyway.
  However, `leave_ledger` is append-only, so a grant written early cannot be removed. One example: a next-year grant
  written today for someone who is terminated in December.
- **Fix (optional):** restrict lazy grants to `period <= current year`. Next-year grants would then come only from
  HR's `grantYear` POST or from the employee's own request POST.

### Info

- **I1:** soft-deleting an employee (RB-05 `softDelete`) does not cancel their pending requests, unlike `terminate`.
  The requests stay pending, cannot be decided (`employeeLive` is false) and come back on restore. Proof:
  `rb06-d1.test.ts` › "terminate hook …".
- **I2:** after termination, approved future leave remains on the calendar and in the ledger until HR cancels it. This
  matches PRD criterion 18.
- **I3:** the shell's `decidableCount` (`DECIDABLE`) runs on every navigation for every user, which adds one bounded
  count (LIMIT 100) per navigation. This is acceptable.

## Controls that held (PASS)

**Approval authorization:**

- The requester, a peer, a skip-level manager, an outsider and a non-fallback admin all get 404 on approve and reject,
  and nothing changes.
- A disabled manager account and a terminated manager record both lose the manager right, and HR takes over.
- When the report moves to another manager after the queue has loaded, the old manager gets 404 and the new manager can
  decide.
- HR cannot decide their own request, even when their record names themselves as manager (`m.id <> e.id`). Another HR
  user decides it.
- The admin fallback applies only when there is no manager account and no other HR user.
- `isHr` and the role come from D1 on every request.

**Balances and the ledger:**

- Approve racing cancel: exactly one wins, and the ledger matches the final status.
- Five parallel cancels produce one reversal (the unique `leave_ledger_reversal_uq`).
- Overlap across types is refused atomically.
- A negative adjustment racing an approval never takes the balance below zero.
- Recomputation at approval is guarded.
- Raw `UPDATE`/`DELETE` on `leave_ledger` is aborted by the triggers, and no app path edits the ledger.
- Logged types and unknown employees cannot be adjusted.
- Proration matches PRD criterion 2 (1st of the month counted, 15th not, leap day, before the start year, null start
  date).
- Day counting handles weekends, deducting and non-deducting holidays, half days, New Year, leap years and 6-day weeks.

**IDOR:**

- Another user's request id gets the same 404 as a missing or malformed id on cancel, approve and reject.
- The team cancel is HR-only.
- All seven settings actions and the settings load answer 404 for a manager, an admin, a member and an outsider, and
  nothing is written.

**Leakage:**

- The calendar payload holds only `{name, part}` per person, plus holiday names. It never contains the type, reason,
  status, request ids or employee ids, and it never shows pending leave.
- "My time off" holds only the viewer's own requests.
- The layout adds only a numeric `pendingApprovals`.
- A manager's queue and team page hold direct reports only.
- There is no `{@html}` and no logging in the time-off trees.

**Plumbing:**

- A cross-site or Origin-less POST to any time-off action gets 403 from the hook, before the route runs.
- Signed-in time-off pages and their `__data.json` are `private, no-store`.
- Date fuzzing is refused: impossible dates, full-width digits, `T` suffixes, signs, five-digit years, NUL bytes,
  31 days back or 367 ahead, and spans over 366 days.
- A balance type cannot cross New Year.
- The calendar month is clamped to 12 months.
- The 21st request in 10 minutes is throttled, failed attempts included, per user.
- Every write compares `updated_at` (stale forms get 409).

**Terminate hook:**

- It cancels only that employee's pending requests, in the same batch, guarded by the termination's `updated_at`.
- A refused termination cancels nothing (also covered by the integration tests).

**Merge check (`throttle.ts`):**

- The RB-00 budgets are unchanged: `THROTTLE_WINDOW_MS` 10 min, `THROTTLE_MINUTE_MS` 1 min, `THROTTLE_MAX_ATTEMPTS` 20,
  `CLIENT_MAX_ATTEMPTS` 100.
- `leave-request` is appended last, and no other scope moved (pinned in `rb06-pure.test.ts`).
- RB-06 relaxed `rb05-pure.test.ts` to `arrayContaining`. The full list is still pinned in `throttle.test.ts` and in
  the new rb06 test.

## Re-check after cycle 2 (2026-10-26)

**Verdict: PASS.** No medium or high findings. Scope: `git diff 9997c60..15022c3` (the `wip(rb-06-time-off): cycle 2`
commit) against this report and `QA_REPORT.md`, with the owner's audited self-approval rule (roadmap §8.1,
decision 10 addendum). One new low finding and two info notes are listed below.

**Method.** I read the diff. I also ran a throwaway D1 suite of 10 attack tests through the real actions and repo, with
batch injection for the races. All 10 passed, which means every control below held. I deleted the suite afterwards,
so nothing new is in the tree. `npm test`: 58 files and 1275 tests passed, exit 0.

### Self-approval attacks (all held)

- **Member with no manager while an HR user exists:** no badge, and the forged `?/approve` gets 404.
  `decide()` returns `not_found` and the request stays pending. A non-HR admin also gets 404, because HR exists.
- **HR user while a second HR user exists:** an active second HR user blocks it (404). A disabled second HR user, or one
  whose HR flag was revoked, does not block it. This matches "no other *active* HR user". `OTHER_HR` checks
  `is_hr = 1 AND status = 'active'`.
- **Manager whose account is disabled:** with no HR, the report may self-approve, because `MANAGER_JOIN` needs
  `mu.status = 'active'`. When the account is enabled again, self-approval is blocked and the manager decides.
  Sign-in lockout uses `locked_until` and does not change `status`, so a requester cannot lock the manager out to
  open self-approval.
- **Race, HR granted between the read and the batch:** the UPDATE writes nothing and the result is `not_found`. There is
  no `leave_self_approve` row (the audit insert is guarded by `changes() = 1`) and no usage row.
- **Race, manager link set between the read and the batch:** the UPDATE writes nothing.
- **Forged decide:** the action rebuilds the viewer from D1 and gates on `approver()`. `canDecide` and `MAY_DECIDE` run
  inside the UPDATE. A self-eligible member cannot decide anyone else's request.
- **Relinked record:** neither the old account nor the new one can self-approve an old request. Both need
  `created_by = actor AND e.user_id = actor`.
- **Soft-deleted employee:** the pending request is canceled in the same batch, and `employeeLive` refuses a decide.
- **Gaming the balance:** there is no edit path. Writes to `leave_requests` happen only in decide, cancel and the RB-05
  hooks. Self-approve, then three parallel cancels: one `usage`, one `reversal`, and the balance is restored exactly.
  `half_days` is recomputed at decide time. A member cannot cancel after the start date.
- **Audit and visibility:** every self decision writes `leave_self_approve` with `user_id = actor` in the same batch
  (`approved · self` or `rejected · self`). `/hr/audit` shows it to HR and to non-HR admins with the "Self" badge
  (`self = 1`). The request also shows "Self-approved" on My time off and on Team.

### Cycle-1 items

- **L2 FIXED (owner chose "allowed, flagged"):** HR self-adjust and the override self-cancel write `user_id = actor` and
  a `· self` detail, shown as "Self" on `/hr/audit`.
- **L3 FIXED:** both the "own" scope and the guarded UPDATE check the current link
  (`e.user_id = ?6 AND e.deleted_at IS NULL AND e.status = 'active'`).
- **L4 FIXED:** the INSERT guard has `NOT EXISTS (… s.start_on > ?4)`. When `start_on` is NULL the request passes.
  No balance grant exists without a start date anyway.
- **L5 FIXED:** `MAY_DECIDE` is inside the approve and reject UPDATE, joined to the actor's active user row. A manager
  change mid-decide, an HR revoke, or a disabled actor writes nothing.
- **L6 FIXED:** no loader calls `ensureGrants`. `balancesFor` adds the missing grant in memory only. The queue's
  "remaining" is read-only.
- **D4 FIXED:** `lazyGrants` returns early when `period < yearOf(teamToday(now))`. Only HR's POST `grantYear` writes
  past-year grants.
- **I1 FIXED:** `softDelete` passes the `cancelPendingRequests(…, 'deleted')` hook. The hook is guarded by
  `deleted_at IS NOT NULL AND updated_at = <the write's updated_at>`, so a refused delete cancels nothing.

### RB-05 regression check (held)

- **`hr/repo.ts`:** the only change is the hook import and the new `after` item on `softDelete`. The batch order is
  still employee UPDATE, then audit (guarded by `changes() = 1`), then the hook. No tier or encryption code changed.
- **`timeoff/hooks.ts`:** a parameterised UPDATE whose only interpolation is a fixed constant chosen by `why`, never
  user input.
- **`hr/audit.ts`:** `self` is derived from `user_id = actor_id`. The SQL is unchanged except for that column, and
  the `employeeHidden` name masking for non-HR admins is untouched. RB-05 rows where an admin acts on their own
  account (for example a self HR grant) now also show "Self". That is correct.
- **Audit page:** the badge is static text. There is no `{@html}`.
- **`hr_audit_log`:** still append-only. There is no action CHECK in SQL, and `checked()` allow-lists the new action.

### New findings

#### N1 (low): the admin fallback and self-approval are both open, so "no other eligible approver" does not hold

- **Where:** `src/lib/server/timeoff/permissions.ts:45-59` (`canDecide`, `selfApprovalAllowed`),
  `src/lib/server/timeoff/repo.ts:263-266` (`MAY_DECIDE`), and `repo.ts:315-326` (`selfApprovalOpen`).
  `approverFor` (`permissions.ts:31-37`) says `'admin'` when another admin exists and `'self'` only when none does.
  `canDecide`, `MAY_DECIDE` and `selfApprovalOpen` ignore `otherAdminExists`. The approval path never uses it.
- **Scenario 1:** the sole HR user has no manager, and a second, non-HR admin exists. The HR user can self-approve
  (audited), and the admin can also approve the same request through the fallback (not audited). Reproduced: the admin
  approves and `self_approved` is 0.
- **Scenario 2:** an admin revokes or disables the only HR user. Every member without a manager can then self-approve,
  although an admin who could approve exists.
- **Why low:** the owner's addendum defines the condition in brackets as "no manager, no other active HR user". The
  code follows that definition. Every self decision is audited and visible to admins. The balance guards still apply.
  Only an admin can change HR grants or disable accounts. The open point is that the headline "only while no other
  eligible approver exists" and the code's own `approverFor` model both count the admin fallback as an approver.
- **Fix (owner to choose):**
  - **(a) Stricter:** add `AND NOT OTHER_ADMIN(req)` to the self branch of `MAY_DECIDE`. Add the matching check to
    `canDecide` and `selfApprovalOpen`, using `otherAdminExists`, which is already read.
  - **(b) Keep as built:** record in the roadmap addendum that a non-HR admin does not switch self-approval off.
    Remove the `'admin'` versus `'self'` distinction from `approverFor`, so the code does not state two rules.

#### Info

- **I4:** a requester rejecting their own request is logged under `leave_self_approve` with the detail
  `rejected · self`, and `self_approved` stays 0. The label "Leave decided by the requester" covers both outcomes.
- **I5:** a sole HR user can self-approve, take the leave, then cancel it through the override after it started, which
  refunds the full usage. Each step writes its own "Self" audit row. This is the L2 behaviour the owner accepted; the
  new part is that self-approval now makes it possible end to end.
