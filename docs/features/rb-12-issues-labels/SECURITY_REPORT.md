# RB-12 Issues and team labels — security report

Reviewer: red-team pentester. Scope: `git diff main..HEAD` at the RB-12 tip (`8b42129`), checked against the PRD and
`docs/ENGINEERING_CHECKLIST.md`. Proof tests: `test/security/rb12-d1.test.ts` (27 tests, local D1). Tests named
`PROOF` assert the weak behaviour as it ships. All other tests assert a defence that holds.

## Verdict: PASS

There are no medium or high findings. Three low findings are listed below so they are tracked.

## Findings

### L1 (low, defence in depth): `createTask` keys label links and the counter bump on "the id exists", not on its own insert

- **Where:** `src/lib/server/tasks/repo.ts:422` (`created = exists (select 1 from tasks t where t.id = ${id})`), used
  at `:440` and `:456` (label link INSERTs) and `:517` (the `next_task_number` bump).
- **Failure scenario:** a caller passes a client id (`options.id`) that already names a task, and the task INSERT in
  the same batch writes 0 rows because its `WHERE` is false (the project is archived, or the assignee is
  inactive). The PK never collides, so the batch commits. The team and project label links are then inserted
  against the **existing** task, which may be another user's task in another project. The archived project's
  counter is also bumped.
- **Reachability:** low. `reportIssue` (`src/lib/server/issues/repo.ts:68-102`) reads the submission id first and
  refuses a taken id. An attacker must therefore make a foreign task with an unpredictable UUID appear between that
  read and the batch, while the project is archived in the same window. The UUID is a CSPRNG value that only the
  victim's form holds, so this is not practical today. It becomes reachable as soon as another caller passes
  `options.id` without that pre-check.
- **Repro:** `rb12-d1.test.ts` › "PROOF L1": `createTask(db, member, {id: archivedProject}, …, {id: victimTask.id,
  labels: {teamLabelIds: [T]}})` answers `archived`, but `task_team_labels` now holds `(victimTask, T)`, and the
  archived project's `next_task_number` went up by 1.
- **Fix:** key the dependent statements on the row this batch wrote. Two options: `exists (select 1 from tasks t
  where t.id = :id and t.project_id = :project and t.created_at = :at and t.created_by = :actor)`, or `changes() > 0`
  read right after the insert. The cheapest option makes the INSERT fail loudly when the id exists:
  `INSERT … SELECT … WHERE NOT EXISTS (select 1 from tasks where id = :id)` plus an explicit check. Add a test that
  the label link and counter bump do not happen when the insert is refused.

### L2 (low / informational): the Report form answers differently for a submission id that names an existing task

- **Where:** `src/lib/server/issues/repo.ts:94-100` (`foreignSubmission`).
- **Scenario:** posting a `submissionId` equal to an existing task id of someone else answers 400 "This form was
  already used". A fresh id is accepted, and a taken id of one's own redirects to that task. This is an existence
  oracle for task ids. Strictly, it goes against the checklist item "hidden and missing ids get the same answer".
- **Impact:** none in practice. Task ids are not hidden: every active member sees every task, and ids are in the
  Issues and project page data. Soft-deleted tasks are refused the same way, so a deleted id is not distinguishable
  from a live one.
- **Repro:** `rb12-d1.test.ts` › "a submission id naming someone else's task (any case, live or deleted) is
  refused; that task is untouched".
- **Fix:** none needed. Optionally, answer a foreign id with the generic "Reload the page and try again".

### L3 (low, carried over from RB-08 L2): cross-project bulk assignment has no request throttle

- **Where:** `src/routes/(app)/issues/+page.server.ts:74-104` and `src/lib/server/pm/bulk.ts:144-185`.
- **Scenario:** the 10-per-request cap (`bulkNotifyMax`) and the RB-01 one-unread-per-task dedupe both hold across
  projects. Assigning 100 tasks over 5 projects writes exactly 10 notifications. Repeating it writes 0, and a
  self-assignment writes 0. However, nothing limits the number of bulk requests. A member can still cycle
  assign → victim reads → reassign over the whole workspace, at 10 notifications per request. RB-12 widens the pool
  from one project to all projects, but not the rate per request.
- **Repro:** `rb12-d1.test.ts` › "100 tasks over 5 projects notify at most 10 per request; dedupe, self and disabled
  assignees hold". The flip-back adds exactly 10 more, with at most 1 unread per task.
- **Fix (optional, as RB-08 L2):** a per-user minute budget on the `bulk` actions through `overUserMinuteLimit`.

## What was attacked and held

| Area | Result |
| --- | --- |
| Authorization | Signed-out requests get 401 on every RB-12 load, action and endpoint (`/issues`, `?/bulk`, `?/saveView`, `?/deleteView`, `/issues/new` load and POST, `/issues/labels`, `/issues/views/[id]`, `/admin/labels`, `/admin`). A member gets 403 on `/admin` and on every `/admin/labels` load and action, and nothing changes. An admin demoted or disabled after the session was read gets 403 on create, rename and delete, because `isActiveAdmin` is re-checked inside each statement. Deactivated sessions are dropped by the hook before any RB-12 route runs. |
| CSRF and caching | Cross-site and `Origin: null` POSTs to all 7 RB-12 actions answer 403 before routing. Signed-in pages and the view opener answer `private, no-store`, and `/issues/labels` sets its own `private, no-store`. |
| Filter and query injection | Every filter value is parsed against a whitelist and bound as JSON or a parameter. A forged filter object that bypasses the parser (with `') or 1=1; drop table tasks; --` in every slot) returns 0 rows and no error. The parser drops `sort`/`dir` injection, `page` outside 1..200 (`1e2`, `0x10`, `-1`, `999`), impossible dates (`2024-02-30`), out-of-range dates (`9999-01-01`), signed years (`+002024-01-01`) and malformed ids. 20,000 repeated `label` and `project` values are cut to 8 and 6 in linear time, and the canonical view query stays at or under 1,000 chars. |
| Query cost | With 3,000 tasks, a maximal hostile URL (max filters plus 2,000 junk labels, `archived=1`, `sort=priority`, `page=200`) and a deep `sort=due` page use no more statements than the plain load (10 or fewer) and finish well within the bound. The count is capped at 10,001 and the offset is at most 9,950. |
| Saved views | Another user's Issues view answers 404 on open (any case) and on delete, and the view stays live. A project form that posts `kind=issues` stores a `list` view. `saveView` refuses a kind/scope mismatch, and the table CHECK refuses `issues` with a project and `list` without one. The stored query comes only from URL re-canonicalisation: a posted `query`, `page`, unknown keys and bad sorts are dropped. The opener always redirects to `/issues?…`. A stored `//evil` stays same-origin, and a CRLF value makes SvelteKit refuse the redirect (no header injection; canonical output cannot hold one anyway). Stale ids in stored filters are dropped at run time. All members see all ids, so a stored id cannot leak anything. |
| Label scopes | A deleted team label is refused by set-labels, by project bulk and by Issues bulk, with no link written. Another project's label is refused on the task form, in project bulk and on the Report form. A team label id posted as a project label is refused. Issues bulk refuses `milestoneId`, `addLabelId` and `removeLabelId` both in `parseBulk` (allowlist) and in `issuesBulkUpdate`. Each case writes nothing. |
| Bulk limits | 101 ids are refused. A task in a deleted project gives `not_found` and a task in an archived project gives `archived`. Both are all-or-nothing, and no priority changed. |
| Combined cap | A task holds 9 labels. Seven project bulk adds, eight Issues team-label adds and one `setTaskLabels` then run concurrently. The task ends with 10 or fewer live labels and 10 or fewer link rows. A deleted label frees a slot and cannot be re-posted. |
| Report an issue | Archived projects get 409 (also for lower-case keys) and deleted projects get 404. Neither is ever preselected by `?project=`, and `/issues/labels` returns `[]` for them. A submission id naming another user's task (live, soft-deleted, upper-case, padded) is refused. The task, its labels and every project counter stay unchanged. One's own task id from another project only redirects to that task. The redirect target is built from the stored row. The `issue-report` throttle (20 a minute) is verified by QA. |
| XSS | Team label names render as text (`&lt;img`). Colours are allowlisted by `parseLabel` and by the `team_labels_color_check` CHECK. Type labels and icons are constants. No new `{@html}` in the diff. |
| Migration 0012 | The `tasks.type` CHECK refuses `epic`. The `task_team_labels` and `saved_views` FKs are enforced. `PRAGMA foreign_key_check` is empty. No `saved_views_new` is left over and the old `saved_views_user_project_name_uq` is gone. Both new partial indexes and the `tasks_fts_ai/au/ad` triggers are present. QA's migration test covers row and FTS preservation. |
| Rebase merges | The RB-09 relative-reminder reset in the shared bulk core is intact for both callers (`bulk.ts:213-234`). Nav keeps Calendar and adds Issues and Report, and has no admin-only leak. |
| Open redirects | The Report redirect is built from `key` and `number` of the stored row. The `?reported=` notice is parsed as `^\d{1,2}-\d{1,2}$`. The view opener stays under `/issues`. |
| Logging | The one new log line (`issues list failed`) logs `errorLabel` only. |

## Checklist

- 100-parameter limit: every id list is bound once through `json_each` (issues filters, bulk, label sets, report
  label checks).
- Concurrent writes: the label cap, the team-label cap, the view cap and the bulk guards are in-statement or
  `batchAssert`-guarded. See L1 for the one dependent statement keyed on the wrong fact.
- Hidden/missing parity: see L2 (informational).
- Form bodies: the Report form uses `LIMITS.formBodyMax` (256 KiB), which fits a 20,000-character description even
  as 4-byte characters (10,000 UTF-16-pair emoji is the length cap).

## Commands

- `RUBY_TEST_WORKERS=2 npx vitest run test/security/rb12-d1.test.ts` → `Tests  27 passed (27)`.
- `npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` → `0 ERRORS 0 WARNINGS`.
- `RUBY_TEST_WORKERS=2 RUBY_E2E_WORKERS=1 npm test` → exit 1, `Tests  1 failed | 1730 passed (1731)`. The one
  failure is unrelated to RB-12: `test/integration/hr.test.ts` › "a member sees tier 0 only". It is a pre-existing
  flaky test. It asserts that the payload has no `'2101'` (a fictional NIK fragment), but that string happened to
  occur inside a random employee UUID (`…-c2101532cca1`), so no data leaked. On a rerun,
  `npx vitest run test/integration/hr.test.ts` gave `Tests  30 passed (30)`. Suggested fix, outside RB-12: match
  the secrets as whole JSON values, or use fragments that cannot occur in hex.
