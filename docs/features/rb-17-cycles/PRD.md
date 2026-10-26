# RB-17 Cycles — PRD

Request: owner, 2026-10-26, tracker roadmap (`docs/features/rb-15-tracker-roadmap.md`, Phase A item 2). RB-17 is
proposed here.

Risk tier: **Large**. Reasons: a column added to the hot `tasks` table, a multi-statement completion batch that moves
many tasks at once, new manager-only surfaces, edits to RB-01 patch/update/create, RB-08 bulk and saved views, RB-12
`/issues` filters, RB-16 sub-issue creation. Pipeline: engineer + QA + red team.

Depends on: RB-01, RB-08 (bulk, saved views, `canManageProject`), **RB-12 merged** (`/issues`, `saved_views`
rebuild), **RB-16 merged** (sub-issue create path). Migration **`0017_cycles.sql`**. Version **0.9.0**.

## Goal

RB-08 milestones are dated targets ("ship 2.0 by 30 Nov"). Teams that plan in fixed periods also need a **time box**:
"this is what we take on in the next two weeks", with a visible end, honest progress, and a clean hand-over of
whatever was not finished. This increment adds **cycles** per project: consecutive, non-overlapping date ranges that
tasks join; a cycle page with progress; a "current cycle" filter everywhere; and a **Complete cycle** step that
records the outcome and carries unfinished tasks to the next cycle.

## Current behaviour this builds on (cite before changing)

- `tasks`: `src/lib/server/db/schema.ts:161-199` (plus `parent_id` from RB-16, `type` from RB-12).
- `milestones`: `schema.ts:276-303`; `pm/milestones.ts` (`createMilestone` :79, `updateMilestone` :145,
  `deleteMilestone` :188, `milestoneProgress` :246, `milestoneTasks` :280); milestone page
  `src/routes/(app)/projects/[key]/milestones/[id]`. Cycles follow the same module shape.
- Manager rule: `src/lib/server/projects/permissions.ts:11` `canManageProject` (lead, creator, admin) and the SQL
  form `pm/common.ts:41` `mayManageProject` / :47 `managerRefusal` (RB-08 red team L1: the rule is checked inside
  the write).
- `tasks/repo.ts`: `milestoneAssignable` :95 (pattern for `cycleAssignable`), `completedAtFor` :107, `createTask`
  :375, `updateTask` :467, `patchTask` :536.
- `tasks/validation.ts`: `PARSERS` :136, `parseFilters` :258; `pm/validation.ts:217` `BulkChanges`; `pm/bulk.ts:24`
  `bulkUpdate`; `pm/query.ts:11` `canonicalizeQuery`.
- Team date: `src/lib/server/tasks/today.ts` (`teamToday`), `tasks/dates.ts` (`isValidDueOn`), `TEAM_TIME_ZONE`.
- RB-09 runs `ruby-jobs` (cron) for reminders only; this PRD adds **no** job.

## Design decisions (the CTO calls; owner can override under Owner decisions)

### D1. A cycle

- Belongs to one project. Fields: `number` (per project, 1, 2, 3 …, never reused), optional `name` (empty shows
  "Cycle N"), `starts_on` and `ends_on` (inclusive team dates `YYYY-MM-DD`), optional `goal` (plain text, multi-line,
  rendered as text with preserved line breaks, never Markdown, never `{@html}`).
- Length **1-56 days** (`ends_on - starts_on` between 0 and 55). Cycles of one project **never overlap**; gaps are
  allowed.
- Status is **derived** from the team date and `completed_at`, never stored: *upcoming* (today < `starts_on`),
  *active* (`starts_on` ≤ today ≤ `ends_on`, not completed), *ended* (today > `ends_on`, not completed), *completed*.
  At most one cycle is active per project (follows from no overlap).
- A completed cycle is read-only and cannot be deleted (it is history). Only not-completed cycles can be edited or
  deleted. Reopening is out of scope (O5).

### D2. Tasks in a cycle

`ALTER TABLE tasks ADD COLUMN cycle_id text REFERENCES cycles(id)`. A task is in at most one cycle of its own
project. It can join an **upcoming, active or ended, not completed** cycle (`cycleAssignable`). Any active user may set
it (RB-01 rule), through:
- the task page sidebar field "Cycle" (`patch` field `cycleId`, version-guarded, bumps `updated_at`);
- the new-task form (optional select; default none, or `?cycle=current`);
- the project list bulk bar (RB-08 `bulkUpdate` gains `cycleId`; same project only). `/issues` cross-project bulk
  does **not** offer cycle (project-scoped, like milestone);
- a sub-issue created from its parent (RB-16 `subAdd`) inherits the parent's cycle when it is not completed.

### D3. Complete cycle (the hand-over)

Manager only (`canManageProject`, checked in SQL). Allowed for an active or ended cycle. A dialog shows counts (done,
canceled, open) and a choice for the **open** tasks (status not `done`/`canceled`):
- **Move to the next cycle** (default when one exists: the earliest not-completed cycle of the project whose
  `starts_on` is after this cycle's `ends_on`);
- **Create the next cycle and move** (offered when none exists: same length, starting the day after `ends_on`,
  or the day after today if that is later);
- **Remove from cycles** (open tasks get no cycle).

One `db.batch`, all or nothing:
1. `batchAssert`: cycle live, not completed, `updated_at = :expected`, project active, actor manages the project
   (SQL form), target (if any) live, not completed, same project, later than this cycle.
2. (create option) `INSERT` the next cycle with the overlap guard, then `batchAssert` it exists (if the guard
   refused it, the batch fails: "Dates overlap another cycle").
3. `UPDATE cycles SET completed_at, completed_by, scope_count, done_count, carried_count` computed in SQL from the
   cycle's live tasks (scope excludes `canceled`) `WHERE id = :id AND completed_at IS NULL`.
4. `INSERT INTO cycle_carryovers (cycle_id, task_id, to_cycle_id, created_at) SELECT …` for the open tasks.
5. `UPDATE tasks SET cycle_id = :target|NULL, updated_at = max(:at, updated_at + 1) WHERE cycle_id = :id AND
   deleted_at IS NULL AND status NOT IN ('done','canceled')`. Bumping `updated_at` makes an open edit form show
   "changed meanwhile" instead of silently putting the task back.

Done and canceled tasks keep `cycle_id` = the completed cycle (history for RB-19). A task's page shows "Carried over
N times" from `cycle_carryovers`. No background job completes cycles (O2): an **ended** cycle shows a banner on the
project page and the cycle page ("Cycle 4 ended on 12 Nov. 7 tasks are still open."), with the Complete button for
managers and plain text for others.

### D4. "Current cycle" as a filter value

`cycle=current|none|<uuid>` on the project list, board and saved views (the literal `current` is stored, so a saved
view "My current cycle" stays current). `current` is resolved on each request to the active cycle on the team date;
with no active cycle the list is empty with "No active cycle" and a link to the cycles page. On `/issues`,
`cycle=current` means "each project's active cycle" (one semi-join on `cycles` by date), `cycle=none` works across
projects, and `cycle=<uuid>` is offered only when exactly one project is chosen (RB-12 milestone rule).

## Scope

### Migration `0017_cycles.sql`

```
CREATE TABLE cycles (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id),
  number integer NOT NULL,
  name text NOT NULL DEFAULT '',
  goal text NOT NULL DEFAULT '',
  starts_on text NOT NULL,
  ends_on text NOT NULL,
  completed_at integer,
  completed_by text REFERENCES users(id),
  scope_count integer, done_count integer, carried_count integer,
  created_by text NOT NULL REFERENCES users(id),
  created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer,
  CONSTRAINT cycles_length_check CHECK (julianday(ends_on) - julianday(starts_on) BETWEEN 0 AND 55),
  CONSTRAINT cycles_completed_check CHECK ((completed_at IS NULL) = (completed_by IS NULL))
);
CREATE UNIQUE INDEX cycles_project_number_uq ON cycles(project_id, number);
CREATE INDEX cycles_project_dates_idx ON cycles(project_id, starts_on, ends_on) WHERE deleted_at IS NULL;

ALTER TABLE tasks ADD COLUMN cycle_id text REFERENCES cycles(id);
CREATE INDEX tasks_cycle_idx ON tasks(cycle_id, status) WHERE cycle_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE cycle_carryovers (
  cycle_id text NOT NULL REFERENCES cycles(id),
  task_id text NOT NULL REFERENCES tasks(id),
  to_cycle_id text REFERENCES cycles(id),
  created_at integer NOT NULL,
  PRIMARY KEY (cycle_id, task_id)
);
CREATE INDEX cycle_carryovers_task_idx ON cycle_carryovers(task_id);
```

Additive. `julianday` on column values is deterministic and allowed in a CHECK; the engineer proves the CHECK
rejects a 57-day cycle and a reversed range in a migration test. `tasks_fts` untouched. `schema.ts`, Drizzle snapshot
(next free snapshot file name; journal tag `0017_cycles`).

### Routes

| Route | Purpose |
|---|---|
| `projects/[key]/cycles/+page.server.ts/.svelte` | Cycles list: active, ended (needs completing), upcoming, completed (20 per page). Actions `create` (manager) |
| `projects/[key]/cycles/[number]/+page.server.ts/.svelte` | Cycle page: dates, goal, status, progress (done / scope), counts per status, tasks grouped by status (≤ 500, link to the filtered list beyond), carried-in marker. Actions `update`, `complete`, `delete` (manager) |
| `projects/[key]` layout | New tab "Cycles"; ended-cycle banner; current-cycle chip linking `?cycle=current` |
| `projects/[key]` list and board | `cycle` filter, Cycle column (list), cycle chip on cards (board, only when not filtered to one cycle) |
| `projects/[key]/tasks/[number]` | Sidebar "Cycle" select (patch `cycleId`), "Carried over N times" |
| `projects/[key]/tasks/new` | Optional Cycle select |
| `issues` (RB-12) | `cycle` filter (D4), Cycle column |
| `my-tasks` | "Current cycle" chip on tasks in an active cycle |

### Server modules

- New `src/lib/server/pm/cycles.ts`: `listCycles(db, projectId, page)`, `getCycleByNumber`, `activeCycle(db,
  projectId, today)`, `nextCycleAfter`, `createCycle`, `updateCycle`, `deleteCycle`, `completeCycle`,
  `cycleProgress`, `cycleTasks`, `cycleAssignable(projectId, cycleId)` (SQL), `currentCycleCondition(today)` (SQL for
  `/issues`), `carryoverCounts(db, taskIds)`.
- New pure `src/lib/shared/cycles.ts`: `cycleStatus(cycle, today)`, `addDays`, `lengthDays`, `defaultNextRange`,
  `CYCLE_LIMITS`.
- Extend, never copy: `tasks/validation.ts` (`cycleId` parser, `TaskFilters.cycle`), `tasks/repo.ts` (`createTask`
  takes `cycleId`, RB-16 sub-issue path inherits it; `updateTask`/`patchTask` add `cycleAssignable`; `rowColumns`
  select cycle number and name), `pm/validation.ts` (`BulkChanges.cycleId`), `pm/bulk.ts` (check + set), `pm/query.ts`
  (`cycle` key for `list`, `board`, `issues`), RB-12 `issues/query.ts`, `pm/extras.ts` (cycle chip data in the same
  batch). `pm/common.ts` manager SQL is reused for every manager action.
- UI: `src/lib/ui/pm/CycleCard.svelte`, `CycleProgress.svelte`, `CompleteCycleDialog.svelte`, `CycleForm.svelte`,
  `CycleChip.svelte`; icon `cycle` in `ICONS`.

## Limits (`CYCLE_LIMITS`, one exported const; client `maxlength` mirrors them)

| Limit | Value |
|---|---|
| Length | 1-56 days, inclusive dates, 2000-01-01..2100-12-31 |
| Live cycles per project | 200; at most 12 upcoming |
| Name | 0-60, single line, control and bidi stripped |
| Goal | 0-500, plain text |
| Cycle page tasks | ≤ 500 (more: "Show all in list") |
| Cycles list page | 20 completed per page; active, ended and upcoming always shown |
| Completion | moves every open task of the cycle in one batch (bounded by tasks in the cycle; tested with 1 000) |

## Authorization per action

| Action | Rule |
|---|---|
| Cycles list, cycle page, filters, chips | `requireUser`; every active user |
| `create`, `update`, `delete`, `complete` | `requireUser` + `canManageProject` on a fresh read, **and** the SQL manager guard inside the write; member gets 403 and nothing changes |
| Set a task's cycle (patch, new task, bulk, sub-issue inherit) | any active user; project active; cycle of the same project, live, not completed |
| Any write in an archived project | refused (409) |

Hidden and missing cycle ids or numbers give the same 404.

## Concurrency (D1: `db.batch`, guarded writes)

- **Create**: `INSERT INTO cycles SELECT :id, :p, coalesce((SELECT max(number) FROM cycles WHERE project_id = :p),
  0) + 1, … WHERE <project active> AND <manager> AND NOT EXISTS (live cycle of :p with starts_on <= :end AND ends_on
  >= :start) AND (live count) < 200 AND (upcoming count) < 12`. Zero rows → follow-up read names the reason. A
  number collision (`cycles_project_number_uq`) retries ≤ 3. Tests: 20 concurrent creates with the same dates →
  exactly one; 20 with distinct non-overlapping dates → 20 with numbers 1..20.
- **Update**: `WHERE id AND deleted_at IS NULL AND completed_at IS NULL AND updated_at = :expected AND <manager> AND
  NOT EXISTS (overlap with another live cycle)`. 0 rows → 404 / 409 stale / "Dates overlap Cycle 3" / "Completed
  cycles cannot change".
- **Delete**: one batch: soft delete `WHERE completed_at IS NULL AND updated_at = :expected AND <manager>`, then
  `UPDATE tasks SET cycle_id = NULL, updated_at = max(:at, updated_at + 1) WHERE cycle_id = :id` guarded by the same
  condition (a `batchAssert` first).
- **Complete**: D3. Tests: two concurrent completes → exactly one; the other gets "Already completed". A task
  assigned to the cycle concurrently either is counted and moved, or is refused afterwards (`cycleAssignable` fails on
  a completed cycle); never stranded open in a completed cycle. A task closed concurrently is counted as done or
  moved, never both. 1 000 open tasks move in one batch within the D1 statement limits (ids are not bound; the
  UPDATE selects by `cycle_id`).
- **Set cycle**: version-guarded patch; bulk is last-writer-wins as RB-08.

## States

- Cycles list: empty "No cycles yet" with "Start a cycle" (managers) or "Ask a project lead to start a cycle"
  (members); active card with progress and days left; ended card with the banner; upcoming list; completed list
  with done / scope / carried; pagination; limit notes; saving and success states for create.
- Cycle page: progress bar with text ("12 of 20 done"); per-status counts; tasks by status; empty "No tasks in this
  cycle" with a link to the list filtered to no cycle; completed summary; delete confirm ("N tasks will leave this
  cycle"); conflict banner for stale edits.
- Complete dialog: counts, radio choice, target cycle name and dates, create-next preview; saving; failure messages
  ("Dates overlap Cycle 6", "Changed meanwhile, reload", "Already completed"); success toast "Cycle 4 completed, 7
  tasks moved to Cycle 5" only after the server confirms.
- Task page: Cycle select saving / conflict like other fields; "Carried over 2 times".
- Filters: "No active cycle" notice for `cycle=current`.

## Mobile layout (402×874, 440×956, 360 px)

- Cycles list: one column of cards (RB-10 `Card`), each card a ≥ 44 px link; active card first.
- Cycle page: header with name and dates wraps; progress bar full width; tasks as stacked rows; status groups
  collapsible (`details`/`summary`, works without JS) with ≥ 44 px summary rows.
- Complete dialog: kit `Dialog` as a bottom sheet below 768 px, own scroll, sticky actions padded by `--sai-bottom`,
  focus returns to the opener.
- Cycle form: single column; date inputs ≥ 16 px; length presets as a segmented control of ≥ 44 px buttons.
- Project tab bar (List, Board, Cycles) scrolls inside its own container if needed, never the page. No page-level
  horizontal scroll at the three widths; safe areas only via `--sai-*`. Viewport spec extended with the cycles list,
  cycle page and complete dialog.

## Performance budget

| Page | Round trips after auth | Statements |
|---|---|---|
| Cycles list | 1 | ≤ 5 (active+ended+upcoming, completed page, counts per cycle via one grouped query, project, user) |
| Cycle page | 1 | ≤ 5 (cycle, progress counts, tasks ≤ 500, carried-in flags, labels via `taskExtras`) |
| Project list / board with `cycle=current` | +0 | +1 (active cycle lookup, in the existing batch) |
| Complete | 2 | ≤ 6 |

Plans: `cycles_project_dates_idx` for overlap and current lookups; `tasks_cycle_idx` for progress and completion.

## Acceptance criteria

Tags: [A] Automated, [P] Pass, [M] manual.

Authorization and safety
1. [A] Signed-out and deactivated requests to the cycles pages and every action are refused.
2. [A] A member posting `create`, `update`, `delete` or `complete` directly gets 403 and nothing changes; the lead,
   the creator and an admin succeed; a lead demoted between load and submit is refused by the SQL guard.
3. [A] A cycle id or number of another project is "not found" on every route and action, also as a task's
   `cycleId` and in bulk.
4. [A] Name and goal render as plain text; `<script>` and Markdown in the goal show literally.

Cycles
5. [A] After `0017`, every task has `cycle_id` NULL, counts and ids unchanged, `integrity_check` ok,
   `foreign_key_check` empty, FTS unchanged; the length CHECK rejects 57 days and a reversed range at the DB level.
6. [A] Creating with overlapping dates is refused; touching ranges (one ends the 14th, next starts the 15th) are
   accepted; ranges sharing a day are refused; the 201st live and 13th upcoming are refused; concurrency as stated.
7. [A] Status derivation is correct at the team-date edges (`starts_on` day, `ends_on` day, day after), using
   `TEAM_TIME_ZONE`, including a UTC time that is already the next day in Jakarta.
8. [A] Editing dates re-checks overlap; a completed cycle cannot be edited or deleted; stale edits give 409.
9. [A] Deleting a not-completed cycle soft-deletes it and clears `cycle_id` on its tasks in one batch.

Tasks and filters
10. [A] A task can join an upcoming, active or ended cycle of its project, not a completed, deleted or foreign one;
    via patch (version-guarded), new task, bulk (100 tasks, same project) and sub-issue inheritance.
11. [A] `cycle=current|none|<id>` returns exactly the expected tasks on list, board, `/issues` and saved views; a
    saved `cycle=current` view follows the active cycle when the date moves (test with a fixed clock); invalid values
    are dropped; canonical worst cases stay within the RB-08 and RB-12 caps.
12. [A] `/issues` `cycle=current` returns tasks in each project's active cycle and nothing from projects without
    one; `cycle=<id>` is ignored unless exactly one project is selected (page notes it).

Completion
13. [A] Completing moves exactly the open tasks to the chosen target (next, new, none), keeps done and canceled in
    the completed cycle, writes `scope_count`, `done_count`, `carried_count` and one `cycle_carryovers` row per moved
    task, bumps moved tasks' `updated_at`, all in one batch.
14. [A] Injected failure (target deleted meanwhile, overlap for the new cycle, stale version, project archived)
    leaves cycle, tasks and carry-over rows untouched.
15. [A] Two concurrent completes: exactly one succeeds. A task assigned during completion is never left open in a
    completed cycle. 1 000 open tasks complete in one request.
16. [A] "Carried over N times" equals the number of carry-over rows of that task.

UI, release, regression
17. [P] Without JavaScript, create, edit, complete (radio choice) and delete work and show errors and success.
18. [P] Viewport spec at 360, 402, 440 px: no page-level horizontal scroll; tap targets ≥ 44 px; dialog clears
    the home indicator; focus returns.
19. [M] Dark mode progress bar and chips AA; keyboard-only completion flow; screen reader reads progress text.
20. [A] Release note `0.9.0.md`; `package.json` and `APP_VERSION` 0.9.0.
21. [A] All RB-01, RB-08, RB-12 and RB-16 tests pass; statement budgets hold with 10 and 500 tasks; plans use the
    new indexes; logs hold ids and counts only.
22. [A] `npm run gates` passes; checklist probes (concurrency at every cap, two tabs, roles crawl, soft delete,
    360 px, no-JS) listed.

## Test plan

Unit: `cycleStatus` at edges and time zones, `defaultNextRange`, length maths, filter parser and canonicaliser
(`current`, `none`, uuid, garbage).
Integration: migration test 0000..0017; overlap matrix; create/update/delete/complete races; completion atomicity
with injected failures; 1 000-task completion; manager matrix (member, lead, creator, admin, demoted lead,
deactivated); bulk with `cycleId`; sub-issue inheritance; `/issues` current-cycle semi-join; query counts and plans;
fixed-clock saved view.
Browser: viewport spec; no-JS completion; dialog focus.
Red team focus: manager bypass by direct POST, cross-project cycle ids in patch and bulk, completion replay, date
injection (`2026-02-30`, far ranges), the batch-size of completion.

## Out of scope

Automatic cycle creation or completion by a schedule (`ruby-jobs`); reopening a completed cycle; cycles across
projects; capacity, estimates or story points; velocity charts (RB-19 shows throughput per cycle); moving a task to
a cycle of another project; cycle-level comments; cycles on the RB-09 calendar (follow-up); notifications on
completion; cross-project bulk set-cycle.

## Prerequisites

None: no variables, bindings or secrets. `TEAM_TIME_ZONE` already set.

## Architecture notes

Mirror the milestone module shape; reuse `canManageProject`, `mayManageProject`/`managerRefusal`, `projectActive`,
`batchAssert`, `isUniqueViolation`, `newId`, `teamToday`, `isValidDueOn`, `taskExtras`, `BulkBar`, `ViewPicker`, kit
`Dialog`, `Card`, `Tabs`. Conflicts with RB-12: extends `parseIssueFilters`, `canonicalizeQuery('issues', …)` and
`IssueTable`; `issuesBulkUpdate` unchanged. With RB-16: `subAdd` inherits the cycle. The open TASKS item "project
board page shows the List/Board switch twice" touches the same project layout; fix it in this PR when adding the
Cycles tab (one tab bar: List, Board, Cycles).

## Migration plan

1. Hand-write `0017_cycles.sql`; generate and hand-check the Drizzle snapshot (next free file name).
2. Migration test over 0000..0016 seeded data (criterion 5).
3. Deploy via `npm run deploy` (bookmark, additive migration, build, deploy). Rollback: `wrangler rollback`; the
   tables and column are ignored by older code.

## Tracker impact

New `docs/TASKS.md` item "RB-17 Cycles (Claude)"; closes the "UI polish: List/Board switch twice" item if fixed here
(quote it in the summary). `docs/ACCEPTANCE.md` rows: completion atomicity and race (Automated), `0017` keeps tasks
(Automated), viewport spec for cycles pages (Pass).

## Owner decisions (proposed defaults)

| # | Decision | Proposed default |
|---|---|---|
| O1 | Who manages cycles | **Project lead, creator or admin** create, edit, delete and complete; **any active user** puts tasks in a cycle |
| O2 | How a cycle ends | **Manual "Complete cycle"** with a banner once it has ended; no scheduled job |
| O3 | Where open tasks go on completion | **Next cycle** by default (create it if none), or no cycle |
| O4 | Length and overlap | **1-56 days, no overlap**, gaps allowed |
| O5 | Reopen a completed cycle | **No** |
| O6 | Done and canceled tasks on completion | **Stay** in the completed cycle (history) |
| O7 | Default name | **"Cycle N"**, custom name optional |
| O8 | Length presets | 1, 2, 3, 4 weeks starting the day after the previous cycle (Monday-start weeks not forced) |
