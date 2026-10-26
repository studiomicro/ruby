# RB-08 Project management plus — security report

Reviewer: red-team-pentester. Scope: `git diff main..HEAD` at the RB-08 tip (commit `10841fb`, "cycle 1"): server
modules `src/lib/server/pm/*`, the edits to `src/lib/server/tasks/{repo,validation,conflict}.ts`, the routes
`projects/[key]` (list/board, `bulk`, `viewSave`, `viewDelete`), `projects/[key]/settings` (label, milestone and
column actions), `projects/[key]/tasks/[number]` (`labelsSet`, `check*`, milestone patch),
`projects/[key]/milestones/[id]`, `projects/[key]/views/[id]` (GET), `my-tasks`, the UI under `src/lib/ui/pm/` and
the board/list components, and migration `0010_pm_plus.sql`. Also checked against `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS

No medium or high findings. Three low findings are listed so they are tracked, plus informational notes.

## Findings

### L1 (low): manager-only RB-08 writes check the role only on the route's read, not inside the write

- **Where:** `src/routes/(app)/projects/[key]/settings/+page.server.ts:59-63` (`managed()`), and the writes it
  guards: `src/lib/server/pm/labels.ts:119-137` (`updateLabel`) and `:154-165` (`deleteLabel`),
  `src/lib/server/pm/milestones.ts:127-134` (`scope`, used by update and status) and `:183-197`
  (`deleteMilestone`), `src/lib/server/pm/columns.ts:104-127` (`saveColumns`). Also `labelSave` with an `id` at
  `settings/+page.server.ts:103`.
- **Scenario:** a lead opens settings and submits "delete milestone" or "save columns" while an admin, in a
  concurrent request, replaces that lead. `canManageProject` passed on the fresh read a few milliseconds earlier;
  the write statement has no manager predicate, so it still lands. RB-01 puts the same rule inside the statement
  (`mayManage`, `src/lib/server/projects/repo.ts:53-56`, answered as `forbidden`), so RB-08 is weaker than its own
  precedent. The window is one round trip, and the actor was a legitimate manager just before, so impact is small.
- **Repro:** `test/security/rb08-d1.test.ts` › "PROOF L1": a db proxy changes `projects.lead_id` right before the
  action's first `db.batch`. `columnsSave` and `milestoneDelete` both return ok, and both writes are stored.
- **Fix:** pass the actor into the manager-only repo functions and add the RB-01 predicate to the guard of each
  write: `projects.lead_id = :actor or projects.created_by = :actor` (or `1=1` for an admin). Put it in
  `batchAssert` for the batches, and in the `WHERE` (as an `exists` on `projects`) for the single UPDATEs. Map a
  miss to 403. Then flip the PROOF test to expect 403 and no change.

### L2 (low): bulk assignment fans out up to 100 notifications per request, with no throttle

- **Where:** `src/lib/server/pm/bulk.ts:69-93`.
- **Scenario:** any active user selects 100 tasks and assigns them to a colleague. That writes 100 `assigned`
  notifications in one request. The RB-01 dedupe holds (verified: no second unread row per task, none to oneself,
  none to a deactivated user). But once the victim marks them read, unassign plus reassign produces another 100.
  RB-01 permits the same loop one task per request, so bulk multiplies it by 100. Every user can already edit every
  task by design, so this is noise and griefing, not a privilege issue.
- **Repro:** `rb08-d1.test.ts` › "PROOF L2": three rounds of (assign 100 → victim reads all → unassign) give 300
  notifications.
- **Fix (owner choice):** add a per-actor cap on bulk-assignment notifications. One option is a single digest row
  ("Mo assigned you 100 tasks") instead of one row per task. Another is a per-actor, per-recipient window of N
  rows. Otherwise, accept the risk and document it in the PRD.

### L3 (low, availability): the milestone form's 8 KiB body cap is below a valid 1,000-character description

- **Where:** `src/routes/(app)/projects/[key]/settings/+page.server.ts:139` reads the body with the default
  `FORM_BODY_MAX_BYTES` (8 KiB). `PM_LIMITS.milestoneDescriptionMax` is 1,000 characters
  (`src/lib/server/pm/validation.ts:24`).
- **Scenario:** 1,000 CJK characters URL-encode to about 9 KB, and 1,000 emoji to about 12 KB. A valid description
  is then refused with a generic 400 "Invalid form", not with the field message. This is not exploitable, but it
  is a refusal of valid input that the checklist's "Form bodies" item says should not happen.
- **Repro:** `rb08-d1.test.ts` › "PROOF L3": `milestoneSave` with `'界'.repeat(1000)` or `'🚀'.repeat(1000)` returns
  400, and no row is written.
- **Fix:** read `milestoneSave` with an explicit bound, e.g. `readFormBody(event.request, 32 * 1024)`. That allows
  12 bytes per character for 1,000 characters plus an 80-character name.

### Informational (no action required)

- **I1.** A bulk status change computes the target column's bottom (`base`, `src/lib/server/pm/bulk.ts:98`) as a
  subquery per updated row. The cost is about 100 × the column's size. That is fine at team scale, but it is the
  most expensive RB-08 statement. If columns grow to tens of thousands of rows, hoist it into a CTE.
- **I2.** Tombstones grow without bound by design: deleted labels keep their `task_labels` links (PRD), and deleted
  checklist steps and saved views stay as rows. Only managers can delete labels, and every row needs a user action.
  No query reads them unbounded: every read filters `deleted_at IS NULL` and has a `LIMIT`.
- **I3.** `projects/[key]/views/[id]` is a `+server.ts`, so the project layout's case redirect does not run. A
  lower-case key answers 404 instead of 301. This is only UX, and the answer is the same as for a missing view.

## Attack surface checked (defences that hold, with proof tests)

All tests are in `test/security/rb08-d1.test.ts` unless another file is named. `test/integration/pm.test.ts` is
the engineer's suite.

| Area | Result |
|---|---|
| Signed-out | 401 on every new load and action (pm.test.ts › access). |
| Deactivated user | Live session dropped by the hook before `bulk`, `viewSave`, `labelSave`, `columnsSave`, `checkAdd` and `labelsSet` run; `no-store`. |
| Member vs lead/creator/admin | Member gets 403 on label rename/delete, milestone create/edit/status/delete and `columnsSave`, with no change. Any member may create labels, edit steps, bulk edit and manage own views, as the PRD says (pm.test.ts). |
| Archived project | Every new mutation refused (409), reads work (pm.test.ts); bulk refused (here). |
| IDOR, labels | A FIN label in `labelsSet` or bulk `addLabelId` is refused with nothing linked. A lead of both projects cannot rename or delete a FIN label through the OPS URL (404, row unchanged). |
| IDOR, milestones | Patch to a FIN milestone: 400, task unchanged. Bulk with a FIN milestone: refused. Milestone page with a FIN id: 404 with the same body as a missing id. Edit/close/delete of a FIN milestone via OPS: 404. |
| IDOR, steps | `checkToggle`, `checkEdit`, `checkMove` and `checkDelete` with a FIN task's step id under an OPS task URL: 404, step untouched (scope `task_id` + `project_id` in SQL). |
| IDOR, saved views | Another user's view: 404 on open and delete, same body as a random id. The owner gets 404 through another project's URL too. |
| Views with unseen or stale ids | The load keeps only live label and milestone ids of this project. A deleted label or milestone in a stored query is dropped, never matched. |
| Bulk cap and atomicity | 101 distinct ids → 400. Over 400 raw values → 400. Duplicates are deduped case-insensitively. A deleted id or a FIN id in the set → 404, and no task, notification or label is written. One `json_each` parameter, so 100 ids stay inside D1's limit. |
| Bulk notifications | RB-01 dedupe holds: repeated or flip-flopped assignment adds no unread duplicate; none to oneself; none to a deactivated assignee (refused). See L2 for the volume. |
| Label cap via bulk | 20 concurrent bulk adds of different labels onto 9-label tasks: each task ends at exactly 10. |
| Count caps under concurrency | 25 concurrent route submissions each against 25 labels, 45 steps and 15 views: exactly 30, 50 and 20 live. |
| WIP limit | Advisory, as the PRD says ("soft limit, warning, never blocks"). A move into an over-limit column is allowed, and 0, 201 and 2.5 are refused (pm.test.ts). |
| Hide a column with tasks | Refused inside the write. Racing a hide against a concurrent bulk move into the column, the hide is refused, or it wins and the move follows. Tasks in a hidden column stay counted (`taskCount`). The board's "N tasks hidden in X" note links to the status-filtered list, so they stay reachable. |
| Column names / XSS | Control, bidi and zero-width characters are stripped and 25 characters are refused. Names render as Svelte text. No `{@html}` anywhere in the diff. |
| Label colour / CSS | Enum in the parser and a DB `CHECK`: a direct insert of `red;background:url(...)` throws. The colour is only a class name, and an out-of-enum value forced into `LabelChip` stays entity-encoded inside `class`. |
| Saved-view query injection | `canonicalizeQuery` drops unknown keys, SQL, JSON, CRLF, `__proto__` and `//evil` values, and enforces the 500-character cap. The route stores `''` for a hostile query. The redirect is always `/projects/<key>[?canonical]`, so there is no open redirect. Filter ids are bound once as `json_each(JSON.stringify(uuids))`, and the sort is whitelisted. |
| Stale edits | Label rename, milestone edit, milestone status, step text and column save against an old `updated_at`: 409, nothing changed. Toggle is last-writer-wins on a boolean, by design. |
| Milestone description | Rendered as plain text (`white-space: pre-wrap`), not Markdown. No `{@html}`. |
| Soft-delete leaks | A deleted label leaves chips, filters and `listTasks`, and cannot be applied by `labelsSet` or bulk. A deleted milestone: page 404, filter dropped, tasks unlinked in the same batch, cannot be assigned by patch or bulk. The task milestone join filters `deleted_at`. |
| Migration 0010 | Additive only. Existing tasks get `milestone_id` NULL (pm.test.ts). The `tasks_fts_*` triggers keep the 0001 definition (`AFTER UPDATE OF title, description`). The new tables have no triggers, and the FK `tasks.milestone_id → milestones` exists. No hard-delete path in `src/` that the new FKs could break. |
| CSRF | Cross-site and `Origin: null` POSTs to the RB-08 actions are refused by the hook before routing. The views route is a GET that changes no state. |
| Cache headers | Signed-in responses (including the view redirect) carry `private, no-store`. Early answers carry `no-store`. |
| DoS / statement count | List and board loads run the same number of D1 statements for 5 and 120 tasks (pm.test.ts). Labels and checklist progress come from one `db.batch` of two grouped queries. Every RB-08 list read has a `LIMIT`. Bulk is at most 6 statements in one batch. |

## Checklist cross-check (`docs/ENGINEERING_CHECKLIST.md`)

- 100-parameter rule: met (JSON lists everywhere).
- Concurrent writes: met (guarded INSERT…SELECT and `batchAssert`). "One access rule": met at the route.
  "Fresh read" is met too, but see L1 for the in-statement check RB-01 adds.
- Hidden and missing ids give one answer: met for views, milestones, labels and steps.
- Tombstones filtered: met. Plain text everywhere: met. Keyed `{#each}` by id: met.
- Form bodies "never refuse honest input": see L3.

## Commands run

- `npx vitest run test/security/rb08-d1.test.ts` → `Tests  27 passed (27)`.
- `npx eslint test/security/rb08-d1.test.ts` → no output (clean). The file was formatted with `npx prettier --write`.
- `npm test` → `Test Files  54 passed (54)`, `Tests  1198 passed (1198)`.

No product code was changed. Nothing was committed, pushed or deployed.
