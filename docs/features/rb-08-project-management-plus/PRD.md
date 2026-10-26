# RB-08 Project management plus — PRD

Risk tier: **Large** (alters hot RB-01 paths: task detail, list, board, bulk writes, new tables referenced from `tasks`; engineer + QA + red team).

Depends on: RB-01 (live; this PRD edits its routes), RB-02 (task FTS stays unchanged), RB-03 and RB-04 (task detail slots already filled). Independent of the HR modules; migration number is the next free at merge (`0005_pm_plus.sql` assumes the HR migrations 0002-0004 merged first).

## Goal

RB-01 gives a solid but minimal tracker: six fixed statuses, a board, a list, one flat task. A small company running real projects soon wants to tag work, break a task into steps, group tasks into a delivery milestone, trim the board to the columns it uses, stop overloading a column, reuse its favourite filters, and change many tasks at once. This increment adds exactly those, without rebuilding the status model.

## Gap analysis: what RB-01 has versus what an owner usually expects

| Expectation | RB-01 today | Decision in this PRD |
|---|---|---|
| Kanban board with drag and drop | Yes: six fixed columns, keyboard and no-JS twin | Keep |
| Multiple boards per project | No (one board per project) | **Not built.** Saved views over the same data cover the need; a second board would duplicate tasks or need a status model change |
| Custom columns / workflow | No (`TASK_STATUSES` fixed, DB CHECK) | **Partly:** per project rename, hide and WIP limit of the existing six columns. Fully custom statuses need a rebuild of `tasks` (CHECK, FTS triggers, indexes) and a rework of "closed" semantics: later, own PRD |
| WIP limits | No | **Built** (soft limit, warning, never blocks) |
| Swimlanes | No | Later (RB-09 candidate: group board by assignee or priority) |
| Labels | No | **Built** |
| Subtasks / checklists | No | **Built as checklists** (lightweight steps inside a task). Full subtasks (child tasks with own status) later |
| Task dependencies (blocked by) | No | Later (RB-09 candidate) |
| Timeline / Gantt | No | Later; needs start dates and dependencies first |
| Sprints | No | Replaced by **milestones** (named target date, progress). Time-boxed sprints later if the team works that way |
| Milestones / releases | No | **Built** |
| Saved views | No (filters in URL only) | **Built** (personal; sharing is an owner decision) |
| Bulk edit | No | **Built** (list view) |
| Recurring tasks, time tracking, estimates, reminders, templates, task move between projects, CSV import | No | Not built; mentioned for the owner's backlog |

## Owner decisions (proposed defaults)

1. Which of the gaps? Default: exactly those marked **Built**.
2. Labels are per project, name 1-30 chars unique ignoring case, one of 8 fixed colours; max 30 per project; max 10 per task. Any active user can create labels and apply them; delete a label: project lead, creator or admin (same rule as project settings).
3. Checklist items: up to 50 per task, 1-200 chars each; any active user may add, tick and delete. Shown as "3/7" on cards and in the list.
4. Milestones: name 1-80, optional description, optional due date, status open/closed; max 50 live per project. A task has at most one milestone. Manage milestones: lead, creator or admin (same as project settings); assign tasks: any active user.
5. WIP limit: integer 1-200 or none, per column per project; exceeded columns show a warning chip, moves are never refused. Column rename 1-24 chars; hide is allowed for any of the six but a column that holds tasks cannot be hidden (shown with "N tasks hidden here" otherwise). Managed in project settings by lead, creator or admin.
6. Saved views are personal (visible only to their creator) in this pass; max 20 per user per project. Team-shared views are a later owner choice.
7. Bulk edit: select up to 100 tasks, set status, priority, assignee, milestone, due date, add or remove one label in one action. Archived projects: refused.
8. Checklist and label changes do not bump `tasks.updated_at` (so they never raise a conflict on someone's open edit form); they carry their own `updated_at`.

## Scope

### Migration `0005_pm_plus.sql`

```
labels(
  id text PK, project_id text NOT NULL REFERENCES projects(id),
  name text NOT NULL, name_key text NOT NULL,   -- lowercased name
  color text NOT NULL CHECK (color IN ('gray','red','orange','yellow','green','blue','purple','pink')),
  created_by text NOT NULL REFERENCES users(id), created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer)
  UNIQUE INDEX labels_project_name_uq ON labels(project_id, name_key) WHERE deleted_at IS NULL

task_labels(
  task_id text NOT NULL REFERENCES tasks(id), label_id text NOT NULL REFERENCES labels(id),
  created_at integer NOT NULL, PRIMARY KEY (task_id, label_id))
  INDEX (label_id)       -- association rows are hard-deleted when unlinked (not user content); a soft-deleted label hides its links in queries

task_checklist_items(
  id text PK, task_id text NOT NULL REFERENCES tasks(id),
  text text NOT NULL, done integer NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  position real NOT NULL, done_by text REFERENCES users(id),
  created_by text NOT NULL REFERENCES users(id),
  created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer)
  INDEX (task_id, deleted_at, position)

milestones(
  id text PK, project_id text NOT NULL REFERENCES projects(id),
  name text NOT NULL, description text NOT NULL DEFAULT '', due_on text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')), closed_at integer,
  created_by text NOT NULL REFERENCES users(id),
  created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer)
  INDEX (project_id, status, due_on)

ALTER TABLE tasks ADD COLUMN milestone_id text REFERENCES milestones(id);
CREATE INDEX tasks_milestone_idx ON tasks(milestone_id) WHERE milestone_id IS NOT NULL;

project_columns(
  project_id text NOT NULL REFERENCES projects(id), status text NOT NULL,
  label text, wip_limit integer CHECK (wip_limit IS NULL OR wip_limit BETWEEN 1 AND 200),
  hidden integer NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)), updated_at integer NOT NULL,
  PRIMARY KEY (project_id, status))      -- a missing row means defaults (enum label, no limit, visible)

saved_views(
  id text PK, user_id text NOT NULL REFERENCES users(id), project_id text NOT NULL REFERENCES projects(id),
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('list','board')),
  query text NOT NULL,     -- canonical URL search params, max 500 chars, whitelisted keys only
  created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer)
  UNIQUE INDEX (user_id, project_id, name) WHERE deleted_at IS NULL
```

`tasks_fts` and its triggers are untouched (labels, checklist text and milestones are not indexed this pass). Existing tasks get `milestone_id` NULL. New enum consts `LABEL_COLORS`, `MILESTONE_STATUSES`, `VIEW_KINDS`.

### Routes and UI (edits to RB-01 trees, all `requireUser` in load and every action)

| Route | Change |
|---|---|
| `projects/[key]/settings` | New sections: Labels (list, create, rename, recolour, delete), Milestones (create, edit, close/reopen, delete), Board columns (label, WIP limit, hidden per status). Actions `labelSave`, `labelDelete`, `milestoneSave`, `milestoneStatus`, `milestoneDelete`, `columnsSave` |
| `projects/[key]/+page` (list) | New filters `label` (multi), `milestone` (`none` or id); new columns Labels and Milestone and checklist progress; row checkboxes and a bulk bar (`?/bulk`); "Save view" and view picker |
| `projects/[key]/+page?view=board` | Column label from `project_columns`, hidden columns removed, WIP chip (`4/3` red when over), label chips and checklist progress on cards, same filters; saved views |
| `projects/[key]/tasks/[number]` | Sidebar fields: Labels (multi-select form, action `labelsSet`), Milestone (patch field `milestoneId` via existing `patch`); new Checklist panel (actions `checkAdd`, `checkToggle`, `checkEdit`, `checkDelete`, `checkMove`) |
| `projects/[key]/milestones/[id]/+page.*` | Milestone page: name, due date, progress bar (closed tasks / total, excluding canceled), task list grouped by status, link to the filtered list |
| `my-tasks` | Shows label chips and milestone; no other change |

All forms work without JS (bulk: checkboxes plus a form with `select` controls; checklist: per-item forms). With JS, ticking a checklist item and applying labels enhance in place. Label chip text is plain text; colour comes from the 8-value enum mapped to CSS variables (light and dark). Colour is never the only signal (chip has text).

### Server modules (`src/lib/server/projects/` and `tasks/` extended)

- `labels/repo.ts`: `listLabels(db, projectId)`, `createLabel`, `updateLabel`, `deleteLabel`, `setTaskLabels(db, actor, task, labelIds, expected?)`, `labelsForTasks(db, projectId, taskIds)`.
- `checklist/repo.ts`: `listItems`, `addItem`, `toggleItem`, `editItem`, `deleteItem`, `moveItem`, `progressForProject(db, projectId, filters)` (join on tasks of the project, **not** an `IN` list of ids; D1 limit 100 parameters).
- `milestones/repo.ts`: `listMilestones`, `getMilestone`, `create/update/setStatus/delete`, `milestoneProgress`.
- `columns/repo.ts`: `getColumns(db, projectId)` → the six statuses with `label`, `wipLimit`, `hidden` merged with defaults; `saveColumns`.
- `views/repo.ts`: `listViews(db, userId, projectId)`, `saveView`, `deleteView`; `views/query.ts` pure `canonicalizeQuery(kind, rawParams)` keeps only whitelisted keys (`status`, `assignee`, `priority`, `label`, `milestone`, `sort`, `dir`, `view`) with validated values; unknown keys dropped; result max 500 chars.
- `tasks/bulk.ts`: `bulkUpdate(db, actor, project, taskIds, changes)`.
- Extend `tasks/repo.ts` `listTasks` and `boardTasks` with label and milestone filters and the joins above.

### Validation (`PM_LIMITS` exported const)

- Label `name` 1-30 single line (trimmed, control and bidi stripped); `color` in enum; 30 labels per project; 10 labels per task.
- Checklist `text` 1-200 single line; 50 live items per task.
- Milestone `name` 1-80; `description` 0-1000; `due_on` empty or valid `YYYY-MM-DD` (2000-01-01..2100-12-31); 50 live per project.
- Column `label` 0-24 (empty = default); `wip_limit` empty or integer 1-200; `hidden` boolean; a column with live tasks cannot be hidden (field error "N tasks use this column").
- Saved view `name` 1-40; 20 per user per project; `query` produced only by `canonicalizeQuery` (never stored raw).
- Bulk: `taskIds` 1-100 uuids (deduped; ids not in the project, deleted or in an archived project make the whole request fail with 404, nothing written); at least one change field; `status`, `priority`, `assigneeId` (empty = unassign, active user), `milestoneId` (empty = clear, open milestone of the same project), `dueOn` (valid date or empty), `addLabelId`/`removeLabelId` (label of the same project).
- `milestoneId` on single patch/update: empty or a live milestone of the same project (open, or the currently assigned closed one).

### Authorization per action

| Action | Rule |
|---|---|
| View anything new | any active user |
| Apply labels, edit checklist, set milestone, bulk edit, saved views of own | any active user; task/milestone/label must belong to the project resolved from the URL; project must be `active` for writes (archived: 409) |
| Create labels | any active user |
| Rename/recolour/delete label, manage milestones, edit board columns | `canManageProject` (lead, creator or admin) |
| Delete checklist item | any active user |
| Saved view edit/delete | owner only (other user's id → 404) |

Every cross-reference is verified against the project in SQL (`… WHERE project_id = :p`); an id from another project is "not found", never accepted.

### Concurrency

- **Label create**: unique partial index `labels_project_name_uq` is the arbiter (case-insensitive via `name_key`); count limit via `INSERT … SELECT … WHERE (SELECT count(*) …) < 30`.
- **Set task labels**: one `db.batch`: delete links not in the new set, `INSERT OR IGNORE` the new ones, count guard `(SELECT count(*) …) <= 10` enforced by applying the whole set only when `length(labelIds) <= 10`; labels are re-verified to belong to the task's project and be live in the same statement (`INSERT … SELECT … FROM labels WHERE id IN (json_each) AND project_id=:p AND deleted_at IS NULL`). Two tabs saving different sets: last write wins (documented; a tag set has no meaningful merge). No `tasks.updated_at` bump.
- **Label delete**: soft; links remain but queries filter `labels.deleted_at IS NULL`; a deleted label cannot be applied; its name becomes reusable.
- **Checklist**: add via `INSERT … SELECT … WHERE (SELECT count(*) … deleted_at IS NULL) < 50 AND EXISTS (live task in active project)`; toggle is `UPDATE … SET done=:v, done_by, updated_at WHERE id AND task_id AND deleted_at IS NULL` (idempotent, no expected check: last writer wins on a boolean); `position` uses midpoint logic like tasks; edit text guarded by `updated_at = :expected` (409 on conflict).
- **Milestone**: update/close guarded by `updated_at = :expected`; closing sets `closed_at`; deleting a milestone clears `tasks.milestone_id` of its tasks in the same batch (`UPDATE tasks SET milestone_id=NULL WHERE milestone_id=:id` — this does not bump `updated_at`), soft-deletes the milestone.
- **Assigning milestone** via the existing task `patch`/`update` (full `updated_at` guard); closed milestones cannot receive tasks.
- **Column settings**: upsert per status with `updated_at` guard on the row set (project `updated_at` is not bumped); hiding re-checked with `NOT EXISTS (SELECT 1 FROM tasks WHERE project_id=:p AND status=:s AND deleted_at IS NULL)` inside the write statement.
- **Bulk update**: one `db.batch` of at most 4 statements: (1) `UPDATE tasks SET …, updated_at = :now … WHERE project_id=:p AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(:ids)) AND EXISTS (SELECT 1 FROM projects WHERE id=:p AND status='active')`; changed statuses place tasks at the bottom of the target column in ascending `number` order and set `completed_at` by the RB-01 CASE rule; (2) assigned-notification insert for the tasks whose assignee changed to a different active user (`INSERT … SELECT … FROM tasks WHERE id IN (…) AND assignee_id=:a AND updated_at=:now`, skipping self-assign), (3) label add/remove as `INSERT OR IGNORE … SELECT` / `DELETE … WHERE label_id AND task_id IN (…)` respecting the 10-labels cap. Pre-check that `count(ids matched) = length(ids)`; mismatch → 404, nothing written; the check and the write are in the same batch via a guard `WHERE (SELECT count(*) …) = :n`, so a task deleted in between cannot be half-updated. No per-task `expectedUpdatedAt` (bulk is last-writer-wins; the UI says so). Result shows "N tasks updated".
- **Saved views**: unique `(user_id, project_id, name)` partial index arbiter; count guard 20.

### States

Settings: empty lists with "Add your first label/milestone"; per-section errors; list view: bulk bar appears when ≥ 1 row selected, "N selected", Apply disabled until a change is chosen, success toast "N tasks updated" only after confirmation, 404 "Some tasks no longer exist, reload"; board: WIP chip states (under, at, over with text "Over limit"), hidden-column note "N hidden columns"; milestone page: empty "No tasks in this milestone"; saved views: empty "No saved views"; checklist: empty "No steps"; at limit messages "A task can have up to 50 steps" etc. Skeletons while navigating.

## Acceptance criteria

1. Signed-out and deactivated users are refused on every new route and action; hidden and missing ids behave the same.
2. Labels: create "Bug" (red); "bug" in the same project is refused (case-insensitive); the same name in another project is accepted; 31st label refused; 31-char name refused; colours outside the enum refused; deleting a label removes it from filters and cards and frees the name.
3. A task can hold at most 10 labels; applying a label from another project or a deleted label is refused with nothing changed.
4. Checklist: add, tick, untick, edit, move, delete work; the 51st live item is refused (concurrent adds against 49 live items: exactly one succeeds); 201-char text refused; progress "3/7" shows on the card, in the list and on the task; ticking does not change `tasks.updated_at` and does not cause a 409 on an open edit form.
5. Milestones: create/edit/close/reopen/delete by a manager of the project only (member gets 403 and nothing changes); 51st refused; assigning a task to a closed milestone, another project's milestone or a deleted one is refused; deleting a milestone clears the link on its tasks; milestone page progress equals closed (done) over non-canceled total.
6. Board columns: renaming "In review" to "QA" shows on the board and settings only; the stored status stays `in_review`; hiding a column that holds tasks is refused; hiding an empty column removes it from the board and from the "+" links; resetting a row to defaults works.
7. WIP: a limit of 3 with 4 tasks shows the over-limit warning; moving a 5th task in is allowed (never blocked); removing the limit clears the chip; limit 0, 201 and non-integers refused.
8. List and board filters by label (OR within the set) and milestone (including `none`) compose with the RB-01 filters; invalid ids are dropped; URLs shareable.
9. Saved views: save from the current filters; opening restores them; stored `query` contains only whitelisted keys (a posted `x=<script>` or an `sort=;drop` is dropped); max 20 per user per project; another user's view id returns 404 on open and delete; duplicate name refused.
10. Bulk edit of 100 tasks (status, priority, assignee, milestone, due date, add label) succeeds in one request and each task has the new values; 101 refused; any id outside the project or deleted → 404 and no task changed; archived project refused; bulk status to `done` sets `completed_at`, back clears it; bulk assignment creates `assigned` notifications only for tasks whose assignee actually changed and never to oneself; the 10-label cap holds during bulk add.
11. Bulk status change appends tasks to the bottom of the target column in ascending number order.
12. Existing RB-01 behaviour is unchanged: all RB-01 tests still pass; board and list performance stays within one extra query per feature (labels, checklist progress, milestone names), independent of task count (query-count test).
13. Task FTS results are unchanged and tombstoned tasks still hidden; the new tables are not part of search.
14. Archived project: every new mutation refused server-side; read views work.
15. All user text (label, step, milestone, view names) is rendered as plain text; no `{@html}`.
16. Board and bulk UI are keyboard operable; checklist and bulk work without JS; 360 px layout without horizontal scroll; colour never the only signal.
17. Migration `0005_pm_plus.sql` applies on a database with existing tasks without data loss; `milestone_id` is NULL for old tasks.
18. `npm run check`, lint and tests pass.

## Test plan

Unit: `canonicalizeQuery` table (whitelist, injection, length cap); name normalisation (`name_key`); column merge of defaults and rows; progress maths; bulk change validator; label colour enum.
Integration (`openLocalD1`, `fakeEvent`, extend `test/helpers/seed-tasks.ts` with labels, milestones, a 120-task project): label unique/limit races; checklist limit race; milestone delete cascade-clear; column hide guard race; bulk atomicity with an injected deleted task; bulk notification matrix; 100-parameter-limit regression (bulk of 100 and a project with 300 tasks on the board); permission matrix (member, lead, admin, other user's view); query-count test for list and board; RB-01 regression suite.
Manual/browser QA: board with WIP warnings, bulk bar at phone width, no-JS checklist and bulk flow, dark mode chip colours.

## Out of scope

Fully custom statuses and workflows; multiple boards per project; swimlanes; task dependencies and "blocked" states; timeline/Gantt; sprints and velocity; subtasks as separate tasks; estimates and time tracking; recurring tasks; reminders; templates; task move between projects; CSV import/export; team-shared saved views; labels across projects; automation rules; checklist items assigned to people; indexing labels/checklists in search; undo for bulk edit.

## Architecture notes

Reuse RB-01 `positionBetween`, `dueBucket`, `canManageProject`, `assignedNotificationStatement`, `LIMITS`, `isUniqueViolation`, `newId`, `errorLabel`, the filter parser in `tasks/validation.ts`. Edit RB-01 route files listed above; do not touch the RB-03 comment and RB-04 attachment slots. New trees: `src/lib/server/{labels,checklist,milestones,columns,views}/**`, `src/routes/(app)/projects/[key]/milestones/**`, `src/lib/ui/pm/**`. D1: pass id lists as one JSON parameter with `json_each` (100-parameter limit); progress and label lookups join on the project's tasks rather than `IN (ids)`.

## Prerequisites

None (no variables, no bindings, no secrets). `TEAM_TIME_ZONE` already set for due-date logic.

## Schema additions

Migration `0005_pm_plus.sql` as above (number = next free at merge).

## Tracker impact

New `docs/TASKS.md` item "RB-08 Project management plus: labels, checklists, milestones, board columns and WIP, saved views, bulk edit" (Claude). Replaces the "subtasks, labels, sprints, custom statuses, bulk edit, saved filters" part of the RB-01 out-of-scope list for the items built. `docs/ACCEPTANCE.md`: bulk atomicity (Automated), RB-01 regression (Automated), board WIP (Pass).
