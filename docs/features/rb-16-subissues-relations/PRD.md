# RB-16 Sub-issues and issue relations — PRD

Request: owner, 2026-10-26, tracker roadmap (`docs/features/rb-15-tracker-roadmap.md`, Phase A item 1). RB-16 is
proposed here.

Risk tier: **Large**. Reasons: a column added to the hot `tasks` table, a new link table read on every list and
board, edits to RB-01 create/patch/delete paths, RB-08 `taskExtras`, RB-12 `/issues` filters and saved-view
canonicaliser, a new JSON lookup route. Pipeline: engineer + QA + red team.

Depends on: RB-01, RB-08 (`pm/extras.ts`, milestones), **RB-12 merged** (`/issues`, `parseIssueFilters`,
`canonicalizeQuery('issues', …)`, rebuilt `saved_views`). Migration **`0013_subissues_relations.sql`** (`0011` RB-09
and `0012` RB-12 are taken). Version **0.6.0**.

## Goal

A task in Ruby is flat. Larger work is split into checklist steps (RB-08), which have no assignee, status or due
date, and nothing records that one task waits on another or repeats another. This increment adds **sub-issues**
(real tasks under one parent, with progress on the parent) and **relations** between any two tasks: *blocks /
blocked by*, *relates to*, *duplicates / duplicated by*. People see what is blocked, what is left inside a larger
piece of work, and where the duplicates went.

## Current behaviour this builds on (cite before changing)

- `tasks` table: `src/lib/server/db/schema.ts:161-199`; `milestone_id` was added by `ADD COLUMN` in
  `migrations/0010_pm_plus.sql` (the pattern this PRD repeats). FTS triggers in `migrations/0001_search.sql`
  fire only `AFTER UPDATE OF title, description`.
- `tasks/repo.ts`: `projectActive` :91, `milestoneAssignable` :95, `completedAtFor` :107, `filterConditions` :114,
  `listTasks` :160, `boardTasks` :199, `createTask` :375, `updateTask` :467, `patchTask` :536, `deleteTask` :718
  (soft delete, idempotent, archived project refuses).
- `tasks/validation.ts`: `PARSERS` / `TASK_FIELDS` :136-148, `TaskFilters` :233, `parseFilters` :258,
  `filtersQuery` :300.
- `pm/extras.ts:16` `taskExtras` batches label chips and checklist progress for a page of tasks (one round trip).
- `pm/milestones.ts:188` `deleteMilestone` clears `tasks.milestone_id` in the same batch without bumping
  `updated_at` (the pattern used for detaching sub-issues).
- `pm/query.ts:11` `canonicalizeQuery(kind, raw)`; RB-12 adds kind `issues` and `PM_LIMITS.issueViewQueryMax` 1 000.
- Task detail route: `src/routes/(app)/projects/[key]/tasks/[number]/+page.server.ts` load :55 (`requireUser`),
  actions from :173 (`update`, `patch`, `delete`, `labelsSet`, `check*`).
- Search: `src/lib/server/search/` (`query.ts` safe MATCH builder, `repo.ts` task hits).
- Throttle: `src/lib/server/auth/throttle.ts` `overUserMinuteLimit`.
- There is no task restore path today; a soft-deleted task stays deleted.

## Design decisions (the CTO calls; owner can override under Owner decisions)

### D1. Sub-issue = a task with `parent_id`, one level deep

`ALTER TABLE tasks ADD COLUMN parent_id text REFERENCES tasks(id)` (nullable, default NULL, allowed by SQLite
`ADD COLUMN` because the default is NULL). No rebuild, so the FTS triggers stay. Rules:

- Parent and child are in the **same project**.
- **One level** (owner decision O1): a parent has `parent_id IS NULL`; a task that has live children cannot become a
  child. This makes cycles impossible with single guarded statements (no recursive check), and D1 serialises
  statements, so two racing "A under B" and "B under A" writes cannot both pass.
- At most **50 live sub-issues** per parent.
- A sub-issue is a normal task in every other way: own status, assignee, due date, labels, milestone, comments,
  attachments, search hit, board card, `/issues` row.
- **Progress** on the parent: closed (`done`) over total live sub-issues excluding `canceled` (the RB-08 milestone
  progress rule). Shown as "3/5" chip on the parent's list row, board card and `/issues` row, and as a bar on the
  task page.
- Closing a parent with open sub-issues is **allowed**; the task page shows "2 sub-issues are still open" next to
  the status field (O2). No cascade in either direction.
- Deleting a parent **detaches** its sub-issues in the same batch (`UPDATE tasks SET parent_id = NULL WHERE
  parent_id = :id`, no `updated_at` bump, like `deleteMilestone`). They become top-level tasks (O3). Deleting a
  child changes nothing else.
- A new sub-issue created from the parent page **inherits the parent's milestone** when that milestone is still open
  (O4); RB-17 adds cycle inheritance.

### D2. Relations: one table, canonical direction

`task_relations` rows, three stored kinds:

| UI wording on task T | Stored row |
|---|---|
| T blocks X | `(from T, to X, 'blocks')` |
| T is blocked by X | `(from X, to T, 'blocks')` |
| T relates to X | `(from min(T,X), to max(T,X), 'relates')` (symmetric, ids compared as text) |
| T duplicates X | `(from T, to X, 'duplicates')` |
| T is duplicated by X | `(from X, to T, 'duplicates')` |

- Unique index `(from_task_id, to_task_id, kind)` is the arbiter for a repeated add. A CHECK forbids a self relation
  and forces `from < to` for `relates`.
- The reverse of `blocks` and of `duplicates` is refused in the same INSERT (`NOT EXISTS` the reverse row). Longer
  blocking chains (A blocks B blocks C blocks A) are allowed: Ruby does not schedule from them, and a recursive check
  is not worth its cost. The task page simply lists them.
- **Cross-project** relations are allowed (every active user sees every project). Both tasks must be live, and both
  projects active and live, to add a relation. Removing needs only the current page's project active.
- At most **50 relations per task** (rows where the task is either end, other end live). Counted inside the INSERT.
- Relation rows are link rows: removing one deletes the row (RB-08 `task_labels` precedent). A relation whose other
  end is soft-deleted stays stored but every read joins both ends and filters `deleted_at IS NULL` and live projects.
- **Blocked**: a task is blocked when at least one live `blocks` row points at it from a live task whose status is not
  `done`/`canceled`. Shown as a "Blocked" badge (icon + text, never colour alone) on list rows, board cards, `/issues`
  rows, My tasks and the task header. Derived at read time; nothing is stored.
- **Duplicate**: marking T as "duplicates X" offers a checkbox "Also cancel this issue" (default on, O5). With it, the
  same batch sets T's status to `canceled` (bottom of the canceled column, `completed_at` by `completedAtFor`) behind
  a `batchAssert` on T's `updated_at = :expected`; a stale version fails the whole batch (409 "changed meanwhile").
- No notifications this pass (O6).

### D3. Choosing the other task

- Primary input: a task key `OPS-12` (pure `parseTaskKey` in `src/lib/shared/task-key.ts`:
  `^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6}$` after trim and upper-case). Works without JavaScript.
- With JavaScript: a combobox backed by `GET /api/tasks/lookup?q=…&project=KEY?` (`requireUser`; JSON; at most 10
  live tasks of live projects; exact key match first, then a title search through the existing search module (safe
  MATCH, never raw); `q` 1-100 chars; throttle scope `task-lookup` 60 per user per minute). Returns key, title,
  status, project key only. Unknown keys and hidden tasks give the same empty answer.
- Server validation never trusts the picker: the posted key is resolved again in SQL.

### D4. Where parent changes happen

- **On the child** (task page sidebar field "Parent"): the existing `patch` action gains field `parentId` (empty =
  none). Normal `updated_at = :expected` guard and conflict screen; the parent guard sits in the same UPDATE's WHERE
  (see Concurrency). Bumps the child's `updated_at`.
- **On the parent** (section "Sub-issues"): `subAdd` creates a new child (title 1-200, optional assignee; status
  `todo`, the RB-01 default) through `createTask` with `parentId`; `subLink` attaches an existing task by key (only
  a task of this project with no parent and no children; no version check, the guard is `parent_id IS NULL`);
  `subUnlink` detaches one child (`WHERE parent_id = :parent`; already detached counts as done). Link and unlink bump
  the child's `updated_at` (an open edit form on the child then shows "changed meanwhile", which is truthful).
- New-task form `projects/[key]/tasks/new?parent=N` pre-selects the parent (validated again on POST).

## Scope

### Migration `0013_subissues_relations.sql`

```
ALTER TABLE tasks ADD COLUMN parent_id text REFERENCES tasks(id);
CREATE INDEX tasks_parent_idx ON tasks(parent_id, number)
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE task_relations (
  id text PRIMARY KEY NOT NULL,
  kind text NOT NULL,
  from_task_id text NOT NULL REFERENCES tasks(id),
  to_task_id text NOT NULL REFERENCES tasks(id),
  created_by text NOT NULL REFERENCES users(id),
  created_at integer NOT NULL,
  CONSTRAINT task_relations_kind_check CHECK (kind IN ('blocks','relates','duplicates')),
  CONSTRAINT task_relations_self_check CHECK (from_task_id <> to_task_id),
  CONSTRAINT task_relations_relates_order_check CHECK (kind <> 'relates' OR from_task_id < to_task_id)
);
CREATE UNIQUE INDEX task_relations_pair_uq ON task_relations(from_task_id, to_task_id, kind);
CREATE INDEX task_relations_to_idx ON task_relations(to_task_id, kind);
```

Additive only. `tasks_fts` and triggers untouched (`parent_id` is not in `UPDATE OF title, description`). Update
`schema.ts` (`tasks.parentId`, `taskRelations`), new const `RELATION_KINDS` in `src/lib/shared/enums.ts`, the Drizzle
snapshot (next free snapshot file name; journal tag `0013_subissues_relations`).

### Routes

| Route | Change |
|---|---|
| `projects/[key]/tasks/[number]` | Load: parent (key, title), sub-issues (≤ 50), relations (≤ 50, both directions, other end live), open-sub-issue count. Actions: `patch` gains `parentId`; new `subAdd`, `subLink`, `subUnlink`, `relAdd`, `relRemove` |
| `projects/[key]/tasks/new` | Optional `parent` (number) pre-selection; validated on POST |
| `projects/[key]` list and board | Progress chip on parents, "Blocked" badge, "Sub-issue of KEY-n" secondary line on list rows; filters `parent` and `blocked` |
| `issues` (RB-12) | Same chips and badge; filters `parent`, `blocked` |
| `my-tasks` | "Blocked" badge |
| `api/tasks/lookup/+server.ts` | New GET, JSON (D3) |

Filters (URL, parsed by `parseFilters` and RB-12 `parseIssueFilters`; unknown values dropped):
`parent=none` (top-level tasks only) or `parent=<task uuid>` (sub-issues of that parent; the UI links it from the
parent's progress chip); `blocked=1` (only blocked tasks). Both added to `canonicalizeQuery` for kinds `list`,
`board` and `issues`. Worst-case canonical length re-proven for both caps (RB-08 500, RB-12 1 000): `parent` adds at
most 43 characters, `blocked` 10.

### Server modules

- New `src/lib/server/pm/hierarchy.ts`: `parentAssignable(projectId, taskId, parentId)` (SQL fragment),
  `listSubIssues(db, parentId)`, `subIssueProgressQuery(db, taskIds)` (grouped counts for a page of parents, ids as
  JSON), `linkSubIssue`, `unlinkSubIssue`, `detachChildrenStatement(db, taskId)`.
- New `src/lib/server/pm/relations.ts`: `listRelations(db, taskId)`, `addRelation(db, actor, task, input, at)`,
  `removeRelation(db, task, relationId)`, `blockedQuery(db, taskIds)`, `blockedCondition()` (SQL for the filter).
- New `src/lib/shared/task-key.ts`: `parseTaskKey`, `formatTaskKey`.
- Extend, never copy: `tasks/validation.ts` (`parentId` parser in `PARSERS`, `TaskFilters.parent`, `.blocked`,
  `filtersQuery`), `tasks/repo.ts` (`createTask` takes `parentId` and inherits the milestone; `updateTask`/
  `patchTask` add `parentAssignable` to the WHERE; `deleteTask` adds `detachChildrenStatement` to its write;
  `rowColumns` selects `parent_id`), `pm/extras.ts` (`taskExtras` adds progress and blocked flags in the same
  batch), `pm/query.ts`, RB-12 `issues/query.ts`, `src/lib/ui/tasks/TaskTable.svelte`, `Board.svelte`, RB-12
  `IssueTable`.
- UI: `src/lib/ui/pm/SubIssues.svelte`, `RelationsPanel.svelte`, `TaskKeyPicker.svelte`, `BlockedBadge.svelte`,
  `SubIssueProgress.svelte` (reuses `ChecklistProgress` styling). New icon names `subissue`, `blocked`, `link` in
  `ICONS` (`src/lib/ui/kit/Icon.svelte`).

## Limits (`PM_LIMITS` additions; client `maxlength` mirrors them)

| Limit | Value |
|---|---|
| Depth | one level (parent → sub-issue) |
| Live sub-issues per parent | 50 |
| Relations per task (either end, other end live) | 50 |
| Relation kinds | 3 stored, 5 shown |
| Sub-issue quick-add title | 1-200 (RB-01 `LIMITS.titleMax`) |
| Task key input | 3-18 chars |
| Lookup `q` | 1-100 chars; 10 results; 60 per user per minute |
| Task page reads | ≤ 50 sub-issues, ≤ 50 relations |

## Authorization per action

| Action | Rule |
|---|---|
| Task page load, `/api/tasks/lookup` | `requireUser` (signed-out: redirect or 401 JSON; deactivated: refused) |
| `patch parentId`, `subAdd`, `subLink`, `subUnlink` | any active user; project active (RB-01 rule: anyone edits any task); every task id resolved inside this project in SQL |
| `relAdd` | any active user; both tasks live; both projects active |
| `relRemove` | any active user; current page's project active; relation must touch the current task (else 404) |
| Duplicate auto-cancel | as `patch` on the current task, behind its version check |

Hidden and missing ids give the same answer (404 body and status). A relation id from another task gives 404.

## Concurrency (D1: `db.batch`, guarded statements, no interactive transactions)

- **Set parent (patch or link)**: one `UPDATE tasks SET parent_id = :p, updated_at = … WHERE id = :t AND project_id
  = :proj AND deleted_at IS NULL AND <projectActive> AND <expected or parent_id IS NULL> AND
  EXISTS (live parent :p in :proj with parent_id IS NULL AND id <> :t) AND
  NOT EXISTS (live child of :t) AND (SELECT count(*) live children of :p AND id <> :t) < 50`. Zero rows → follow-up
  read decides 404 / 409 stale / field error ("This task has sub-issues", "That task is already a sub-issue",
  "A task can have up to 50 sub-issues"). Tests: 20 concurrent links at 49 children → exactly one succeeds; A-under-B
  and B-under-A concurrently → exactly one succeeds; link while the parent is deleted → either the link fails or the
  delete detaches it, never a live child of a deleted parent.
- **Sub-issue create**: RB-01 create batch (counter bump + insert) with the parent guard in the INSERT … SELECT; retry
  ≤ 3 on a number collision as today.
- **Parent delete**: `deleteTask` writes the soft delete and `detachChildrenStatement` in one batch.
- **Relation add**: one `INSERT … SELECT … WHERE <both live, both projects active> AND NOT EXISTS (reverse row for
  blocks/duplicates) AND (count for task A) < 50 AND (count for task B) < 50`; unique index decides a repeat
  (`isUniqueViolation` → "Already linked"). Tests: 20 concurrent adds at 49 → exactly one; A-blocks-B and B-blocks-A
  concurrently → exactly one.
- **Duplicate + cancel**: `db.batch([batchAssert(T version, live, project active), insert relation, update T status])`.
- Relation and sub-issue reads never lock anything; a deleted other end simply disappears from lists.

## States

- Task page **Sub-issues**: empty "No sub-issues" with quick-add field and "Link existing"; list with status,
  assignee, due; progress bar; at-limit note; per-row unlink with saving state; errors under the field.
- Task page **Relations**: empty "No linked issues"; grouped "Blocked by", "Blocks", "Relates to", "Duplicates",
  "Duplicated by"; each row key, title, status, project key (other project marked); add form (kind select, key
  input or combobox, optional cancel checkbox for duplicates); saving, success toast after server confirm, field
  errors ("No task with that key", "That would block itself", "Already linked", "This task has 50 links").
- Parent field: shows "Sub-issue of OPS-3 Title" with a link; "2 sub-issues are still open" note on a parent being
  closed.
- Lookup: loading spinner, "No matches", error fallback to plain key input.
- Lists, board, `/issues`: chips render without layout shift; blocked badge with accessible text.

## Mobile layout (402×874, 440×956, 360 px)

- Task page sections stack in one column below 768 px: Sub-issues then Relations after the description, before
  comments. Each row is one tappable link ≥ 44 px tall; unlink and remove buttons ≥ 44×44 px with `aria-label`.
- Add forms stack (kind select, key input, Add button full width); inputs ≥ 16 px. The combobox list opens below the
  input inside the page flow (no overlay that can leave the viewport) and is padded by `--sai-bottom` when near the
  tab bar.
- Chips wrap; long titles wrap; no page-level horizontal scroll at the three widths. Safe areas only via `--sai-*`.
- Uses RB-10 kit: `Card`, `Badge`, `Select`, `TextField`, `Button`, `Checkbox`, `Toaster`, `EmptyState`.
- Extend the Playwright viewport spec: task page with 50 sub-issues and 50 relations, project list with chips,
  `/issues` with `blocked=1`.

## Performance budget

| Page | Round trips after auth | Statements added |
|---|---|---|
| Task page | unchanged | +3 (sub-issues, relations, parent row) in the existing batch |
| Project list / board / `/issues` / My tasks | unchanged | +2 in `taskExtras` (progress, blocked flags), independent of row count |
| `relAdd` with cancel | 1 | 3 |
| Lookup | 1 | ≤ 2 |

`EXPLAIN QUERY PLAN`: progress uses `tasks_parent_idx`; blocked flags and the `blocked=1` filter use
`task_relations_to_idx`; no full scan of `tasks` beyond what the page already does.

## Acceptance criteria

Tags: [A] Automated (Vitest, local D1), [P] Pass (browser or real runtime), [M] manual.

Authorization and safety
1. [A] Signed-out and deactivated requests to the task page, every new action and `/api/tasks/lookup` are refused;
   the lookup answers 401 JSON with no data.
2. [A] Task, parent, relation and key inputs from another project (for parent) or another task (for relation ids)
   are "not found"; hidden and missing give the same status and body.
3. [A] An archived project refuses every new write on its tasks; a relation cannot be added to a task of an
   archived project; reads still work.
4. [A] Titles, keys and project names in sub-issue and relation lists and lookup JSON are plain text (no `{@html}`);
   lookup output carries no description.

Sub-issues
5. [A] After `0013`, every existing task has `parent_id` NULL, row count and ids unchanged, `integrity_check` ok,
   `foreign_key_check` empty, FTS results identical before and after, `tasks_fts_*` triggers present.
6. [A] Creating a sub-issue from the parent gives a new numbered task in the same project with `parent_id` set,
   created_by = actor, status `todo`, and the parent's open milestone; a closed milestone is not inherited.
7. [A] A task of another project, a deleted task, itself, a task that already has a parent, or a task with
   sub-issues cannot become a parent or child; each gives the stated field error and writes nothing.
8. [A] 20 concurrent links at 49 sub-issues leave exactly 50; concurrent A-under-B and B-under-A leave exactly one
   link.
9. [A] Progress counts done over live non-canceled sub-issues; a deleted sub-issue leaves the count.
10. [A] Deleting a parent soft-deletes it and sets `parent_id` NULL on its live sub-issues in the same batch, without
    changing their `updated_at`.
11. [A] Changing `parentId` via `patch` with a stale version gives 409 and the conflict screen; `subLink` on a task
    that got a parent meanwhile gives "That task is already a sub-issue".
12. [A] Closing a parent with open sub-issues succeeds and the page shows the open count.

Relations
13. [A] Each of the five wordings stores the canonical row; "T relates to X" and "X relates to T" are the same row;
    adding the same relation twice gives "Already linked".
14. [A] A self relation and the reverse of a `blocks` or `duplicates` row are refused, also when the two adds race.
15. [A] Cross-project relations work; both ends must be live tasks in active projects.
16. [A] The 51st relation on either end is refused; 20 concurrent adds at 49 leave exactly 50.
17. [A] "Blocked" appears exactly when a live open task blocks the task; closing or deleting the blocker clears it;
    `blocked=1` returns exactly those tasks on the project list, board and `/issues`.
18. [A] "Duplicates X" with cancel sets the task to `canceled` with `completed_at`, at the bottom of the column, in
    one batch; with a stale version nothing is written; without the checkbox only the relation is added.
19. [A] Removing a relation deletes the row; a relation id of another task gives 404; a relation to a deleted task is
    hidden from both pages and from counts.

Filters, views, lookup
20. [A] `parent=none`, `parent=<id>` and `blocked=1` compose with the RB-01, RB-08 and RB-12 filters; invalid values
    are dropped; saved views store them; canonical worst cases stay ≤ 500 (project views) and ≤ 1 000 (issue views).
21. [A] Lookup: exact key first, title matches next, ≤ 10, live only; a 100-character term full of FTS operators
    returns results or empty, never 500; the 61st call within a minute answers 429.
22. [A] Statement budgets above hold and do not grow between 10 and 500 tasks (query counter); plans use the new
    indexes.

UI, release, regression
23. [P] Without JavaScript, the key inputs add and link; with JavaScript the combobox works by keyboard.
24. [P] Viewport spec at 360, 402, 440 px: no page-level horizontal scroll, tap targets ≥ 44 px, inputs ≥ 16 px.
25. [M] Dark mode: badges and chips AA-readable; screen reader announces "Blocked" and progress.
26. [A] Release note `src/lib/content/releases/0.6.0.md`; `package.json` and `APP_VERSION` 0.6.0 (RB-11 guard).
27. [A] All RB-01, RB-02, RB-08 and RB-12 tests pass; logs carry ids and counts only, never titles.
28. [A] `npm run gates` passes; `ENGINEERING_CHECKLIST.md` probes (concurrency at both caps, two tabs, roles crawl,
    soft delete, FTS after create/edit/delete, 360 px, no-JS forms) run and are listed.

## Test plan

Unit: `parseTaskKey` (case, spaces, bounds, `OPS-0`, `OPS-01`), relation wording → canonical row mapping, filter
parser and canonicaliser additions (worst-case length), progress maths.
Integration (`openLocalD1`, `fakeEvent`; extend `test/helpers/seed-tasks.ts` with parents, 50-child parent,
cross-project relations, archived project): migration test over seeded data applying 0000..0013; guard matrix for
parent rules; races (links at cap, mutual parenting, relation cap, reverse blocks, link versus delete); duplicate
cancel batch atomicity; blocked derivation after status change and delete; lookup throttle and FTS escape;
permission matrix (signed-out, member, admin, deactivated); query-count and `EXPLAIN QUERY PLAN` tests.
Browser (Playwright, outside `gates`): viewport spec; no-JS add/link flow; combobox keyboard flow.
Red team focus: cross-project parent ids, relation id scoping, lookup as an existence oracle and as an FTS injection
point, unbounded relation fan-out, duplicate-cancel version bypass.

## Out of scope

Nested sub-issues beyond one level; converting checklist steps into sub-issues; moving a sub-issue to another
project; cascading status or close; auto-closing a parent; relation notifications; blocker-aware scheduling or
critical path; relation kinds beyond the three; bulk set-parent; showing relations on the board as lines; timeline
(RB-23); sub-issue templates; undo.

## Prerequisites

None: no variables, bindings or secrets.

## Architecture notes

Reuse `newId`, `isUniqueViolation`, `batchAssert`/`isBatchAssertFailure`, `projectActive`, `completedAtFor`,
`POSITION_STEP`, `taskExtras`, the search module's MATCH builder, `overUserMinuteLimit`, the safe-return helper and
the form-body guard. Do not touch the RB-03 comment and RB-04 attachment slots. Conflicts with RB-12: extends
`parseIssueFilters`, `canonicalizeQuery('issues', …)` and `IssueTable`; `issuesBulkUpdate` is unchanged (parent is
project-scoped and stays out of cross-project bulk). RB-17 will add cycle inheritance in `createTask`'s sub-issue
path; RB-18 adds grouping by parent.

## Migration plan

1. Write `0013_subissues_relations.sql` by hand as above; generate the Drizzle snapshot (next free snapshot file
   name) and hand-check it matches.
2. Migration test: seed with 0000..0012, apply 0013, assert criterion 5.
3. Deploy: `npm run deploy` records the D1 Time Travel bookmark, applies 0013 remotely (additive), builds, deploys.
   Rollback: `wrangler rollback` for the app; the column and table can stay (old code ignores them); restore the
   bookmark only if data must be reverted.

## Tracker impact

New `docs/TASKS.md` item "RB-16 Sub-issues and issue relations (Claude)". `docs/ACCEPTANCE.md` rows to add: `0013`
keeps tasks and FTS (Automated), parent and relation cap races (Automated), viewport spec for the task page
sections (Pass). Moves the "subtasks as separate tasks" and "task dependencies" items out of RB-08's out-of-scope
list.

## Owner decisions (proposed defaults)

| # | Decision | Proposed default |
|---|---|---|
| O1 | Sub-issue depth | **One level** (parent → sub-issue). Deeper nesting needs recursive guards |
| O2 | Closing a parent with open sub-issues | **Allowed with a note**; no cascade |
| O3 | Deleting a parent | **Detach** its sub-issues (they become top-level); not deleted with it |
| O4 | What a new sub-issue inherits | **Project and open milestone**; status `todo`; no assignee unless chosen |
| O5 | Marking a duplicate | Checkbox "Also cancel this issue", **on by default** |
| O6 | Notifications for relations and sub-issues | **None** this pass |
| O7 | Cross-project relations | **Allowed** (one team sees everything) |
| O8 | Caps | **50 sub-issues per parent, 50 relations per task** |
