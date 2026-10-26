# RB-01 Projects and tasks — PRD

Risk tier: **Large** (new route tree, ~10 server functions with multi-statement batches, optimistic concurrency, drag-and-drop with a no-JS twin, cross-user notification insert). Needs engineer + QA + security review.

Depends on: RB-00 foundation only (`requireUser`/`requireAdmin`, UI kit, `renderMarkdown`, `openLocalD1`/`fakeEvent`). **Buildable in parallel with RB-02**; RB-03 and RB-04 depend on this PRD. Schema is fixed: no schema additions (see end).

## Goal

The core of Ruby: the team organises work in projects, each with numbered tasks (`OPS-12`), seen by every active user. A task has a status (board column), priority, assignee, due date and a Markdown description. Two views of a project (filterable list, status board) plus a personal "My tasks" page. Assigning a task to someone else leaves an `assigned` notification row that RB-03 will display.

## Owner decisions (defaults accepted 2026-10-26)

1. Any active user may create projects and tasks and edit any task. Archive/unarchive a project: lead, creator or admin. Soft-delete a task: its creator, the project lead or admin. Edit project name/description/lead: lead, creator or admin.
2. An archived project is frozen for task create/edit/move/delete (read-only). Comments and attachments on its tasks still work (RB-03/RB-04 do not check archive state).
3. "Today" for due-date logic uses env var `TEAM_TIME_ZONE` (IANA name), fallback `UTC`. Value: `Asia/Jakarta`, set in `wrangler.jsonc` vars.
4. Task numbers are never reused after soft delete.

## Scope

### Routes (all under `src/routes/(app)/`, all require `requireUser` in `load` AND in every action)

| Route | Purpose |
|---|---|
| `projects/+page.svelte` / `+page.server.ts` | Project list. Query `?archived=1` shows archived instead of active. Row: key, name, lead, open-task count (status not done/canceled, not deleted), updated. Button "New project". |
| `projects/new/+page.*` | Create form (action `default`). |
| `projects/[key]/+layout.server.ts` | Resolves project by key (uppercased; if URL case differs, 301 to uppercase). Unknown key or `deleted_at` set: 404. Provides `project` to children. Header: key badge, name, lead, tabs List / Board / Settings, plain anchor "Docs" to `/kb/projects/<KEY>` (RB-02 route; may 404 until RB-02 ships, accepted). Archived banner when archived. |
| `projects/[key]/+page.*` | List view (default). `?view=board` switches to board (same load function; a view toggle is two links, no JS). |
| `projects/[key]/settings/+page.*` | Edit name/description/lead; archive/unarchive. Actions `update`, `archive`, `unarchive`. |
| `projects/[key]/tasks/new/+page.*` | Create task (action `default`); accepts `?status=` preset (used by board column "+" link). |
| `projects/[key]/tasks/[number]/+page.*` | Task detail. Param must match `^[1-9][0-9]{0,8}$` else 404. Actions: `update` (full edit), `patch` (single-field quick change), `delete`. |
| `my-tasks/+page.*` | Tasks assigned to me. |

Task detail leaves two empty marked slots in `+page.svelte` for later PRDs: `<!-- RB-04:attachments -->` above the description footer and `<!-- RB-03:comments -->` at the bottom. RB-01 renders nothing there.

### Page structure

- **List view**: filter bar (GET form, works without JS): Status (multi-checkbox, default all except nothing hidden; `closed` shown, sorted last), Assignee (select: Anyone / Me / Unassigned / each active user), Priority (multi-checkbox). Sort select `sort=number|priority|due|updated` + `dir=asc|desc` (default `number desc`). Table columns: identifier (`KEY-N`, link), title, status chip, priority, assignee (avatar initials + name), due (red when overdue and open). Pagination: 50 per page, `?page=N` (offset), "Showing a-b of total". Filter state is in the URL.
- **Board view**: one column per `TASK_STATUSES` in order, header = label + count, cards = identifier, title (2-line clamp), priority dot, assignee initials, due date. Each column shows up to 100 tasks ordered by `position asc, number asc`; if more, footer "N more — open list view with this status" linking to the filtered list. Same filters (assignee, priority) apply; status filter hides columns. "+" link per column opens new-task form preset to that status. Archived project: no drag, no "+", no move form.
- **Move without JS**: every card contains a `<form method=POST action="?/move">` with `<select name=status>` (current preselected), `<select name=place>` (`top` / `bottom`, default `bottom`) and a "Move" button. With JS, drag-and-drop (pointer events; keyboard: focus card, Space to lift, arrows to move, Enter to drop) posts the same action with `status` + `afterTaskId` (empty = top of column) via `fetch` and applies the result optimistically; on failure it reverts the card and shows an error toast.
- **Task detail**: title (h1) with identifier; two-column layout: left = rendered description (`renderMarkdown`) with "Edit" toggling an edit form (textarea + Preview tab using `renderMarkdown` client side or a `?/preview` action — engineer's choice, but preview output must come from the same sanitising function); right = fields: status, priority, assignee, due date, created by/at, updated at, completed at. Each field in the sidebar is a tiny form (`?/patch`, one field, auto-submit with JS, submit button inside `<noscript>`). Danger zone: Delete task (confirm page when no JS: `?/delete` requires `confirm=yes` checkbox).
- **My tasks**: grouped sections Overdue / Today / Upcoming (due later) / No due date, each sorted by priority desc (`urgent` first) then due then number. Excludes closed tasks; toggle `?closed=1` appends a "Closed" section of the 50 most recently completed. Includes tasks in archived projects (marked with an "Archived" chip). Row links to task detail and shows project key.

### Server modules (`src/lib/server/projects/` and `src/lib/server/tasks/`)

`projects/validation.ts` — zod schemas below. `projects/repo.ts`:
- `listProjects(db, { archived })`, `getProjectByKey(db, key)`, `createProject(db, actor, input)`, `updateProject(db, actor, projectId, input, expectedUpdatedAt)`, `setProjectArchived(db, actor, projectId, archived, expectedUpdatedAt)`, `projectOpenCounts(db, projectIds)`.
- `projects/permissions.ts` — `canManageProject(actor, project)` (lead, creator or admin), `canDeleteTask(actor, project, task)`.

`tasks/validation.ts`, `tasks/repo.ts`:
- `listTasks(db, projectId, filters, sort, page)` → `{rows,total}`; `boardTasks(db, projectId, filters)` → rows grouped by status (100 cap each + counts via one grouped count query); `getTaskByNumber(db, projectId, number)`; `createTask(db, actor, project, input)`; `updateTask(db, actor, task, input, expectedUpdatedAt)`; `patchTask(db, actor, task, field, value, expectedUpdatedAt)`; `moveTask(db, actor, taskId, status, placement)`; `deleteTask(db, actor, taskId)`; `listMyTasks(db, userId, { closed })`.
- `tasks/position.ts` — pure functions: `positionBetween(prev|null, next|null)` (see Concurrency), `needsRenumber(prev, next)`.
- `tasks/dates.ts` — `isValidDueOn(s)`, `todayIn(zone, now)`, `dueBucket(dueOn, today)`.
- `tasks/assign-notification.ts` — `assignedNotificationStatement(db, {taskId, assigneeId, actorId, now})` returns a Drizzle batch item (see below). RB-03 does not modify it.

### Validation (server side, zod; client hints mirror it; all strings trimmed, NUL and C0/C1 control chars except `\n`/`\t` stripped, zero-width and bidi-override chars stripped from titles/names)

- Project `key`: input trimmed, uppercased, must match `^[A-Z][A-Z0-9]{1,9}$`; unique (catch `isUniqueViolation` → field error "That key is already used"). Immutable after creation (field absent on edit, ignored if sent).
- Project `name`: 1–80 chars, single line (newlines collapsed to space). `description`: 0–5000 chars Markdown. `leadId`: empty or an `active` user id (checked); on edit a currently-assigned disabled lead may be kept.
- Task `title`: 1–200 chars, single line. `description`: 0–20 000 chars. `status` ∈ `TASK_STATUSES`, `priority` ∈ `TASK_PRIORITIES`. `assigneeId`: empty or active user id (an unchanged, now-disabled assignee is kept untouched). `dueOn`: empty or `YYYY-MM-DD` that round-trips through `Date.UTC` (rejects 2026-02-30) between 2000-01-01 and 2100-12-31.
- `expectedUpdatedAt`: integer ≥ 0, required on `update`, `patch`, project `update`/`archive`.
- `move`: `status` ∈ enum; exactly one of `afterTaskId` (uuid, may be empty = top) or `place` ∈ `top|bottom`.
- Filters (query params): unknown status/priority values are dropped (not an error); `assignee` ∈ `me|none|<uuid>`; `page` integer 1–10 000 (else 1); `sort`/`dir` whitelisted.
- All limits in one exported const object `LIMITS` in `tasks/validation.ts`.

### Authorization per action

| Action | Rule |
|---|---|
| Any load/action | `requireUser` (active user). Disabled → RB-00 handles. |
| Create project, create task, update task, patch, move | any active user; task actions need project `status = 'active'` (else 409 "Project is archived"). |
| Edit project, archive/unarchive | `canManageProject`. |
| Delete task | `canDeleteTask`. |
| View anything | any active user. Deleted rows: 404. |

Every action re-reads the project/task server-side; ids from forms are never trusted for scope (a `taskId` is always resolved together with its project and the project's archive state).

### Concurrency (D1: `db.batch`, no interactive transactions)

- **Create task** (reads `nextTaskNumber = N` first; retry up to 3 times on conflict). One `db.batch`:
  1. `UPDATE projects SET next_task_number = N+1, updated_at = :now WHERE id = :p AND status='active' AND deleted_at IS NULL AND next_task_number = N`
  2. `INSERT INTO tasks (...) SELECT ..., N, ... FROM projects WHERE id = :p AND next_task_number = N+1` with `position = (SELECT coalesce(max(position),0)+1024 FROM tasks WHERE project_id=:p AND status=:s)`.
  3. If assignee ≠ actor: the assigned-notification `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM tasks WHERE id=:newTaskId) AND EXISTS (active user)`.
  A concurrent creator that read the same N either changes 0 rows in step 1 and inserts nothing, or collides on `tasks_project_number_uq`; the unique error rolls back the whole batch, the loop re-reads N and retries. After 3 failures return 409 "Busy, try again". Check `results[0].meta.changes === 1`; if 0 re-read and distinguish "archived/deleted" from "raced".
- **Update/patch**: `UPDATE tasks SET …, updated_at = max(:now, :expected+1), completed_at = <rule> WHERE id=:id AND deleted_at IS NULL AND updated_at = :expected` (and project active via `AND EXISTS (SELECT 1 FROM projects WHERE id=tasks.project_id AND status='active')`). `changes = 0` → re-read; if deleted → 404; else **conflict**: respond 409 re-rendering the form with the current server values and the user's submitted values side by side per differing field, buttons "Use theirs" (reload) and "Keep mine" (resubmit with the fresh `expectedUpdatedAt`). The assigned notification for an assignee change is part of the same batch, guarded with `WHERE changes() > 0`-equivalent: `INSERT … SELECT … FROM tasks WHERE id=:id AND assignee_id=:newAssignee AND updated_at=:newUpdatedAt`.
- `completed_at`: set to `now` when status moves from non-closed to a `CLOSED_TASK_STATUSES` member, set NULL when moving back to non-closed, unchanged closed→closed; computed in SQL (`CASE`) from the stored status so a racing writer cannot leave it wrong.
- **Move**: guarded `UPDATE tasks SET status, position, completed_at (CASE as above), updated_at WHERE id=:id AND deleted_at IS NULL` and project active. Last move wins (no expected check; the card's neighbours are advisory). Position: read prev (the `afterTaskId` task's position, must be in target status of same project, else treat as bottom) and its next sibling; `positionBetween(prev, next)` = midpoint; no next → `prev + 1024`; no prev (top) → `first − 1024` or `0` when the column is empty. If `next − prev < 1e-6`, renumber the column in one `db.batch` of guarded UPDATEs (`1024 * i`) then recompute. Two simultaneous drops into the same gap may produce equal positions; ties are broken by `number asc` in all queries, so order stays deterministic.
- **Delete**: `UPDATE tasks SET deleted_at=:now, updated_at=… WHERE id=:id AND deleted_at IS NULL`; 0 changes → treat as already deleted (idempotent success).
- **Project edit/archive**: same `updated_at = expected` guard on `projects`. Creating a task also bumps `projects.updated_at`, so editing project settings after a task was created in another tab shows a conflict; acceptable, the form reloads.

### Assigned notification (insert only)

Row: `kind='assigned'`, `user_id=assignee`, `actor_id=actor`, `target_kind='task'`, `target_id=task.id`, `comment_id` null, `created_at=now`, `read_at` null, `id=newId()`. Created on task create with assignee, and on assignee change (to a new, active user). Not created when assignee = actor, when assignee is cleared, when assignee unchanged, or on move/other edits. Re-assigning A→B→A creates a new row each time (no dedupe).

### Loading / empty / error states

- Navigation uses SvelteKit `load`; list and board show kit skeleton rows/cards while navigating (`navigating` store).
- Empty: no projects ("Create your first project" button); project with no tasks ("No tasks yet — create the first one"); filters match nothing ("No tasks match these filters" + "Clear filters"); empty board column ("No tasks"); My tasks empty ("Nothing assigned to you").
- Errors: field errors inline under inputs with `aria-describedby`; form-level banner for 409/500; 404 page for unknown project/task; 403 not used (all see all). Saving: submit button disabled + spinner under `use:enhance`; success: redirect/flash toast "Task saved". All forms submit and render correctly with JS disabled (`use:enhance` is progressive).

## Acceptance criteria

1. Signed-out request to any RB-01 route/action redirects/401s per RB-00; disabled user denied.
2. Creating a project with key `ops` stores `OPS`; keys `A`, `1AB`, `ABCDEFGHIJK`, `A-B`, `ÄB` are rejected with field errors; duplicate key rejected without a 500.
3. Project key cannot be changed through the edit action even if the field is posted.
4. Creating a task assigns `number = next_task_number` and bumps the counter in the same batch; 10 concurrent creates in the same project yield numbers 1..10 with no gaps, no duplicates (integration test).
5. Creating a task in an archived or missing project returns 409/404 and inserts nothing.
6. Title 0 or 201 chars, description 20 001 chars, invalid status/priority, bad `dueOn` (e.g. `2026-02-30`, `2026-1-1`), non-active assignee are rejected with field errors; boundary values (1/200 chars, 20 000 chars) are accepted.
7. Editing with a stale `expectedUpdatedAt` returns 409 showing both versions and changes nothing; "Keep mine" then succeeds.
8. Moving a task to `done`/`canceled` sets `completed_at`; moving back clears it; `done`→`canceled` keeps the original value.
9. Board shows six columns in `TASK_STATUSES` order; cards ordered by `position` then `number`; a column with >100 tasks shows 100 and the "N more" link.
10. Drag-and-drop persists across reload; dropping between two cards gives a position strictly between theirs; when the gap is < 1e-6 the column is renumbered and order is preserved.
11. With JS disabled, the per-card move form moves a task to the chosen status at top/bottom, and the page re-renders the board.
12. `afterTaskId` pointing to a task in another column/project/deleted is ignored (placed at bottom), never errors with a leak.
13. Assigning to another active user inserts exactly one `assigned` notification; self-assign, unassign, no-change and disabled-user assignment insert none (disabled → validation error).
14. Notification insert and task write succeed or fail together (batch); a failing write leaves no notification.
15. List filters (status, assignee `me`/`none`/user, priority) compose with AND within different filters and OR within one; URLs are shareable; invalid values are ignored; 50 per page with correct total.
16. Overdue styling shown only for open tasks whose `due_on` < today in `TEAM_TIME_ZONE`.
17. My tasks lists only tasks assigned to the viewer, non-deleted, open by default, grouped correctly; `?closed=1` adds ≤ 50 closed ones.
18. Soft-deleted tasks disappear from list, board, My tasks and detail (404); their number is not reused.
19. Task delete is refused for a user who is not creator/lead/admin (403), and no row changes.
20. Archived project: all task mutations refused server-side (not only hidden in UI); read views still work; unarchive restores.
21. Descriptions render via `renderMarkdown`; a `<script>` or `javascript:` link in a description is inert (test with the sanitiser output).
22. `/projects/ops` redirects to `/projects/OPS`; `/projects/OPS/tasks/0`, `/abc`, `/99999999999` return 404.
23. Every form works with JS disabled; every control has a label; board is keyboard operable.
24. No `any`, `npm run check`, lint and tests pass; no migration added.

## Test plan

Vitest unit (`src/lib/server/**/*.test.ts`): key regex table; validation limits at boundaries; `positionBetween`/`needsRenumber`; `isValidDueOn`/`dueBucket`/`todayIn` incl. zone edges; `completed_at` transition table; permission helpers; filter parsing.
Integration with `openLocalD1` + `fakeEvent`, helper `test/helpers/seed-tasks.ts` (this PRD only): createProject uniqueness; createTask numbering and 10-way `Promise.all` race; archived refusal; update conflict path and "keep mine"; move ordering, renumber, cross-column `completed_at`; assigned notification matrix (create/reassign/self/unassign/disabled); delete idempotence and permissions; listTasks filters/sort/pagination; listMyTasks grouping; authorization for each action with a non-lead member and an admin.
Component/route: load functions return 404s as specified. Manual/browser QA: drag with mouse and keyboard, no-JS move form, conflict screen on two tabs, phone width.

## Out of scope

Comments (RB-03), attachments (RB-04), notifications UI (RB-03), search (RB-02), subtasks, labels, sprints, custom statuses, task activity/history log, bulk edit, task move between projects, project hard-delete, project templates, CSV import/export, due-date reminders, recurring tasks, assignee multiple, saved filters, task watchers.

## Architecture notes

- Reuse: `newId`, `isUniqueViolation`, `errorLabel` from `src/lib/server/util.ts`; enums and `CLOSED_TASK_STATUSES` from `src/lib/shared/enums.ts`; `TASK_STATUS_LABELS`/`TASK_PRIORITY_LABELS`.
- Shared files touched: **none** outside this PRD's own trees (`src/routes/(app)/projects/**`, `my-tasks/**`, `src/lib/server/projects/**`, `src/lib/server/tasks/**`, `test/helpers/seed-tasks.ts`). The app-shell nav already links `/projects` and `/my-tasks` (RB-00).
- Contracts other PRDs rely on: URL `/projects/<KEY>/tasks/<N>` is the canonical task link; the two slot comments in the task detail page; task title/`KEY-N` display helper `formatTaskRef(key, number)` exported from `src/lib/server/tasks/format.ts` (pure, no DB).
- Prerequisites: env var `TEAM_TIME_ZONE` (optional). No secrets.

## Schema additions

None. (`tasks.position` REAL, `projects.next_task_number`, `tasks.completed_at` and the existing indexes cover every query; filters use `tasks_project_status_idx` and `tasks_assignee_idx`.)
