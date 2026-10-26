# RB-12 Issues and team labels — PRD

Request: owner, 2026-10-26, "add issues pages" and "add labels". RB-12 is proposed here (no ID was given).

Risk tier: **Large**. Reasons: a column added to the hot `tasks` table (FTS triggers), a rebuild of the live `saved_views` table, a new cross-project query over every task, a cross-project bulk write, edits to RB-01/RB-02/RB-08 code (task detail, create, search, bulk, label set), a new admin surface. Pipeline: engineer + QA + red team.

Depends on: RB-01 (tasks), RB-02 (search), RB-03 (task detail slots untouched), RB-08 (labels, saved views, bulk; live as migration `0010_pm_plus.sql`), RB-11 (release notes). Migration `0012_issues_labels.sql` is the next free number after RB-09's `0011` (in build). If `0011` is not merged yet, `0012` still applies (wrangler orders by file name); do not reuse `0011`. Version **0.5.0** (RB-09 is 0.4.0).

## Goal

Ruby tracks tasks per project. Nobody can see "every open bug across all projects", file a bug in ten seconds from wherever they are, or tag work with labels that mean the same in every project. This increment adds:

1. A **type** on every task (Task, Bug, Feature request, Improvement) and a cross-project **Issues** page with filters, sorting, bounded pagination, saved views and capped bulk edit.
2. A quick **Report an issue** form that creates a normal task.
3. **Team labels**: workspace labels managed by admins, usable in every project, next to RB-08's project labels.

## Current behaviour this builds on (cite before changing)

- `tasks` table: `src/lib/server/db/schema.ts:161-199`. `created_by` NOT NULL = who filed the task. No type column. Indexes: `tasks_project_status_idx`, `tasks_assignee_idx (assignee_id, status)`, partial `tasks_milestone_idx`.
- FTS triggers (`migrations/0001_search.sql`): `tasks_fts_au` is `AFTER UPDATE OF title, description`. An update of any other column does not touch the FTS table.
- RB-08: `labels` (project-scoped, `labels_project_name_uq` partial unique on `(project_id, name_key)`), `task_labels (task_id, label_id)`, `saved_views (user_id, project_id NOT NULL, kind CHECK list|board)`; `migrations/0010_pm_plus.sql`. `LABEL_COLORS` in `src/lib/shared/enums.ts:181`.
- Code to extend: `src/lib/server/pm/labels.ts` (`setTaskLabels`, `labelsForTasksQuery`), `pm/views.ts`, `pm/query.ts` (`canonicalizeQuery(kind, raw)`), `pm/bulk.ts` (`bulkUpdate`, single project, 100 ids, one `db.batch`, `batchAssert`), `pm/validation.ts` (`PM_LIMITS`: `labelsPerTask: 10`, `bulkMax: 100`, `viewQueryMax: 500`, `viewsPerUserProject: 20`), `tasks/repo.ts` (`listTasks`, `listMyTasks`, `createTask`, `filterConditions`), `tasks/validation.ts` (`LIMITS`, `parseFilters`, `TASK_FIELDS`), `search/repo.ts` (`TaskHit`, `tasks_fts` query), `src/lib/ui/shell/nav.ts`.
- Routes: `projects/[key]/views/[id]/+server.ts` opens a saved view by redirect; 404 for another user's view.
- Nav today: `NAV_SECTIONS[0]` = Home, My tasks, Projects, Knowledge base; `TAB_ITEMS` = those four; everything else lands in the phone More sheet through `moreItems()`.
- `package.json` version and `wrangler.jsonc` `APP_VERSION` are 0.3.0; `src/lib/content/releases/` holds the notes (RB-11: deploy refuses when they disagree).

## Design decisions (the CTO calls; owner can override under Owner decisions)

### D1. Task type: a column on `tasks`, no rebuild

`ALTER TABLE tasks ADD COLUMN type text NOT NULL DEFAULT 'task' CHECK (type IN ('task','bug','feature_request','improvement'))`.

Verified against SQLite rules: `ADD COLUMN` may be `NOT NULL` when it has a non-NULL constant default, and may carry a `CHECK` (the check is run against existing rows; the default `'task'` satisfies it). No table rebuild, so the `tasks_fts_*` triggers stay as they are. `type` is not in `UPDATE OF title, description`, so changing a type never re-indexes FTS. Existing rows read `'task'`. The engineer must prove this with a migration test on a seeded database: row count unchanged, every row `type = 'task'`, `PRAGMA integrity_check` ok, `PRAGMA foreign_key_check` empty, and an FTS search before and after the migration returns the same hits. Constant `TASK_TYPES = ['task','bug','feature_request','improvement']`, labels `Task`, `Bug`, `Feature request`, `Improvement`, in `src/lib/shared/enums.ts`. Each type has a fixed icon plus text (never colour alone; the 8 label colours are for labels only).

### D2. Reporter: no new column

`tasks.created_by` is the reporter, and every creation path (Report form, task form) sets it to the acting user. A separate `reporter` would only matter for "file on behalf of someone", which was not asked for, and it would duplicate a NOT NULL FK. UI shows "Reporter" for `created_by`; the Issues page filters on it (`reporter=me|<user id>`). Never editable. Index `tasks_created_by_idx` serves the filter.

### D3. Team labels: separate `team_labels` + `task_team_labels`, not a nullable `labels.project_id`

Chosen: **two new tables**, `labels` untouched.

Why not make `labels.project_id` nullable:
- SQLite cannot drop NOT NULL in place. It needs the 12-step rebuild of `labels` (create `labels_new`, copy, drop, rename, recreate `labels_project_name_uq`), and `task_labels` holds an FK to `labels(id)`. That means `PRAGMA defer_foreign_keys`, a copy of live data and a second unique index for the `project_id IS NULL` scope, on a table that RB-08 only just shipped.
- RB-08 code assumes a label belongs to its task's project everywhere: `labelsForTasksQuery` joins `t.project_id = labels.project_id`, `setTaskLabels` and `bulkUpdate` check `l.project_id = :p`, the 30-per-project cap, the manager rule. A NULL scope would make every one of those a special case, and one missed `project_id = :p` becomes a cross-project leak.
- A separate pair keeps the RB-08 guards intact and gives team labels their own simple rules (admin-only writes, 100 cap, one global name space).

Cost accepted: label reads merge two sources (one extra statement, batched in the same round trip), and a label filter checks two link tables. Ids are UUIDs, so a filter id matches at most one table. A team label and a project label may share a name (no cross-check, no race); the UI marks team chips with a "Team" icon and groups pickers as "Team" and "This project".

### D4. Combined label cap

A task carries at most **10 labels in total** (project + team), live labels only. This keeps RB-08's `labelsPerTask: 10` and makes it count both link tables. Every writer enforces it in SQL: `setTaskLabels`, bulk add (project or team), the Report form's create batch. Parser rejects a posted set of more than 10 ids before the write.

### D5. Saved views: generalise `saved_views` by rebuild (small leaf table)

Owner asked to reuse RB-08 saved views for a cross-project scope. Chosen: **one table, one code path**, by rebuilding `saved_views` in `0012`:

- `project_id` becomes nullable; `kind` accepts `'issues'` besides `'list'`, `'board'`.
- Table CHECK `((kind = 'issues') = (project_id IS NULL))`: an issues view has no project, a project view always has one.
- Unique name rule becomes two partial unique indexes: `saved_views_project_name_uq (user_id, project_id, name) WHERE deleted_at IS NULL AND project_id IS NOT NULL` and `saved_views_issues_name_uq (user_id, name) WHERE deleted_at IS NULL AND project_id IS NULL` (SQLite treats NULLs as distinct in a unique index, so the second index is needed).
- Safe rebuild: `saved_views` is a leaf. Nothing references it, it has no triggers and no FTS. Sequence in the migration file: `PRAGMA defer_foreign_keys = on;` `CREATE TABLE saved_views_new (...)`; `INSERT INTO saved_views_new (id,user_id,project_id,name,kind,query,created_at,updated_at,deleted_at) SELECT … FROM saved_views`; `DROP TABLE saved_views`; `ALTER TABLE saved_views_new RENAME TO saved_views`; create both indexes (the old index dies with the old table). FKs to `users` and `projects` are kept. Soft-deleted rows are copied too.
- Rejected alternative: a separate `issue_views` table. No rebuild, but two copies of list/get/save/delete/limit code and two openers. The rebuild is small and fully testable.
- RB-08 reads stay correct: `listViews`, `getView`, `deleteView` filter `project_id = :p`, so an issues view is invisible to project routes and a project view is invisible to `/issues/views/[id]`.

`canonicalizeQuery(kind, raw)` gains kind `'issues'`. Whitelisted keys, fixed order, each value validated, unknown keys and bad values dropped:
`type` (in TASK_TYPES, multi), `status`, `priority` (multi), `label` (uuid, multi, max 8), `assignee` (`me|none|uuid`), `reporter` (`me|uuid`), `project` (project key `^[A-Z][A-Z0-9]{1,9}$`, uppercased, multi, max 6), `milestone` (`none|uuid`), `created_from`, `created_to`, `updated_from`, `updated_to` (`YYYY-MM-DD`, 2000-01-01..2100-12-31, round-trips through `Date.UTC`), `archived` (`1`), `sort` (`updated|created|priority|due`), `dir`. Never `page`. Stored `query` max **1 000** chars for issues (`PM_LIMITS.issueViewQueryMax`); worst-case canonical output is about 900, proven by a test. RB-08's 500 stays for project views.

Opening a view: `GET /issues/views/[id]` (requireUser, own live view only, else 404) redirects 303 to `/issues?<query>`. Saving: action `?/saveView` on `/issues` (the query is re-canonicalised from the current URL params, never posted raw). Deleting: `?/deleteView`. Cap **20 per user** for the issues scope (count inside the INSERT). Views are personal (RB-08 decision 6).

A stored `project` key whose project was deleted is dropped at run time and the page shows "1 filter no longer applies".

### D6. Bulk on `/issues`: RB-08 bulk generalised across projects

New `issuesBulkUpdate(db, actor, taskIds, changes, at)` shares the RB-08 core (extract the shared pieces from `pm/bulk.ts`; do not copy them). Same shape: ids bound once as JSON, **max 100 ids** (`PM_LIMITS.bulkMax`), **one `db.batch`, all or nothing**, first item is a `batchAssert`. Selection comes from the current page only (50 rows), never "select all matching".

- Allowed changes: `status`, `priority`, `type`, `assigneeId` (empty = unassign, active user), `dueOn`, `addTeamLabelId`, `removeTeamLabelId`. At least one required.
- **Not allowed across projects**: milestone and project labels (both are project-scoped). They stay in the project list's RB-08 bulk bar. A cross-project bulk bar simply does not show them. (`type` is also added to RB-08's own `BulkChanges` so the project list can set it.)
- Guard: `count(tasks that are live, in the id set, and whose project is active and not deleted) = n`. Any id missing, deleted, or in an archived project fails the whole request with nothing written. UI message distinguishes 404 "Some tasks no longer exist, reload" from 409 "Some selected tasks are in archived projects" (checked in the follow-up read after a failed assert).
- Status change: each task goes to the bottom of the target column **of its own project**, ascending `number` within a project: `position = (select coalesce(max(position),0) … where project_id = tasks.project_id and status = :s and id not in ids) + rank * POSITION_STEP`, with `rank` counted among selected tasks of the same project. `completed_at` by the RB-01 `completedAtFor` rule.
- Assignee: same `assigned` notification rules as RB-08, at most `bulkNotifyMax` (10) per request, never to oneself, no second unread per task.
- Team label add: insert-select only for tasks under the 10-label combined cap; the result reports how many were skipped ("N tasks already have 10 labels"). Remove: delete links for the selected tasks.
- No per-task version check (last writer wins; the bar says so), as RB-08.

### D7. Report an issue

- Route `/issues/new` (GET load, `default` action). Works without JS. Deep links: `?project=KEY&type=bug`.
- Fields: Project (select of **active** projects, required), Type (default **Bug**), Title (1-200), Description (Markdown, 0-20 000, with the existing preview field `DescriptionField`; output only through `renderMarkdown`), Labels (optional; team labels plus the chosen project's labels, combined max 10), Priority (optional, default `none`). No assignee, no status, no due date (set them on the task afterwards).
- Creates a normal task through `createTask` (extended with `type`, `labelIds`, `teamLabelIds`, optional client `id`): number from the project counter, `created_by = actor`, status **`backlog`** (Owner decision O3), `type` as chosen. Label links are inserted in the **same create batch** (INSERT … SELECT … from live labels of the right scope), so a task never exists half-labelled. A label deleted between page load and submit is skipped and the success toast says how many labels applied.
- Success: redirect 303 to the new task page with toast "Reported OPS-12". The redirect target is built from the new task, never from user input.
- Project labels depend on the project: on `/issues/new?project=KEY` the page loads that project's labels. With JS, changing the project calls `GET /issues/labels?project=KEY` (requireUser, JSON, at most 30 rows) and swaps the project-label group, keeping typed text; without JS a "Show labels for this project" GET button in `<noscript>` reloads with `?project=`. Typed values are carried in the query for that reload only for `type` and `priority`; title and description are not echoed in a URL (privacy and length): the noscript flow warns "Choose the project first". Server validation never trusts the picker.
- Default project: `?project=` if valid and active, else the project of the viewer's most recent task (one indexed lookup on `tasks_created_by_idx`), else none.
- **Double submit**: the form carries a client-generated UUID `submissionId` that is used as `tasks.id`. A second POST with the same id hits the primary key; the action then finds that task (`created_by = actor`) and redirects to it. One task, never two. An id that exists but belongs to someone else is a plain validation error.
- Throttle: new scope `issue-report` through `src/lib/server/auth/throttle.ts` (`overUserMinuteLimit`), 20 reports per user per minute, answers 429 with "Slow down a little".
- Archived project: refused server-side 409 "This project is archived" and not offered in the picker (Owner decision O5).

### D8. Where things live in the UI

- `/issues` (page, nav item "Issues", new icon `issues` added to `ICONS` in `Icon.svelte`).
- `src/lib/ui/shell/nav.ts`: add `ISSUES` to `NAV_SECTIONS[0]` after My tasks: Home, My tasks, **Issues**, Projects, Knowledge base (five items; the first group stays the daily-work group; no new section). `TAB_ITEMS` stays four items, so **Issues is reachable on a phone through More**; QA checks that it appears first in More (order = sidebar order). If the owner wants Issues in the tab bar, it replaces nothing silently; that is a separate decision (O8, default: keep tabs unchanged).
- **Report an issue entry**: exported `REPORT_ISSUE: NavItem` (`href '/issues/new'`, label "Report an issue", icon `plus`, short "Report"). Sidebar: one icon-only button with `aria-label` and tooltip in the head next to Search and Notifications (no new row, no new nav item, sidebar not longer). Phone: first row of the More sheet, and the top bar keeps only Search and Notifications. Also a primary "Report an issue" button in the `/issues` page header on every width. `moreItems()` returns `REPORT_ISSUE` first; `nav.test.ts` is extended (unique hrefs, Issues in section 0, not in TAB_ITEMS, Report first in More, sidebar item count unchanged at 5 + 2).
- `/admin/labels` linked from the `/admin` hub page (not a new sidebar item; the Admin footer link already leads there).
- Task detail: Type is a sidebar field (select, `patch` field `type`), "Reporter" shows `created_by`. The Labels field shows Team and Project groups in one multi-select form (action `labelsSet`, now sets both).
- Type badge (icon + text; for `task` the board card shows nothing to stay quiet) on: `/issues`, project list, project board cards (non-task only), My tasks, `/search` task hits, task detail header.

## Scope

### Migration `0012_issues_labels.sql` (hand-checked against the Drizzle snapshot; additive except the `saved_views` rebuild)

```
ALTER TABLE tasks ADD COLUMN type text NOT NULL DEFAULT 'task'
  CHECK (type IN ('task','bug','feature_request','improvement'));      -- constraint name tasks_type_check
-- indexes for /issues (partial: live rows only)
CREATE INDEX tasks_live_updated_idx ON tasks(updated_at, id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_live_created_idx ON tasks(created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_live_type_idx    ON tasks(type, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX tasks_created_by_idx   ON tasks(created_by, created_at) WHERE deleted_at IS NULL;

team_labels(
  id text PK, name text NOT NULL, name_key text NOT NULL,
  color text NOT NULL CHECK (color IN (<LABEL_COLORS>)),
  created_by text NOT NULL REFERENCES users(id),
  created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer)
  UNIQUE INDEX team_labels_name_uq ON team_labels(name_key) WHERE deleted_at IS NULL

task_team_labels(
  task_id text NOT NULL REFERENCES tasks(id), team_label_id text NOT NULL REFERENCES team_labels(id),
  created_at integer NOT NULL, PRIMARY KEY (task_id, team_label_id))
  INDEX task_team_labels_label_idx ON task_team_labels(team_label_id, task_id)

-- saved_views rebuild (see D5): PRAGMA defer_foreign_keys = on; CREATE saved_views_new; INSERT … SELECT;
-- DROP saved_views; RENAME; CREATE both unique indexes; table CHECKs:
--   kind IN ('list','board','issues'), ((kind='issues') = (project_id IS NULL))
```

`tasks_fts` and its triggers are untouched. Update `schema.ts`, `VIEW_KINDS`, `TASK_TYPES`, and the Drizzle snapshot (`migrations/meta/0012_snapshot.json`, `_journal.json` entry tag `0012_issues_labels`). Index rationale: default sort `updated` and `created` walk a live-only index; `type`+`updated` serves the type filter; `created_by` serves the reporter filter and the default-project lookup; assignee, project/status and milestone already have indexes. Four new indexes slow task writes slightly; accepted for one team.

### Routes

| Route | Purpose |
|---|---|
| `issues/+page.server.ts/.svelte` | Issues list; actions `bulk`, `saveView`, `deleteView` |
| `issues/new/+page.server.ts/.svelte` | Report an issue (action `default`) |
| `issues/labels/+server.ts` | GET `?project=KEY` -> that project's live labels (JSON, at most 30) |
| `issues/views/[id]/+server.ts` | GET open an issues saved view (redirect) |
| `admin/labels/+page.server.ts/.svelte` | Team label management (`requireAdmin`): actions `create`, `update`, `delete` |
| `projects/[key]/tasks/[number]` | Type field (`patch`), Reporter row, labels form for both kinds |
| `projects/[key]/tasks/new` | Type select (default Task) |
| `projects/[key]` list and board | Label filter covers both kinds; chips show both; type badge |
| `my-tasks`, `search` | Type badge (`TaskHit.type`; the `tasks_fts` query selects `t.type`) |

### `/issues` page

- **Rows**: every live task of every live project the viewer can see. Archived projects are hidden unless `archived=1` ("Include archived projects" switch). Deleted projects' tasks never appear.
- **Filters** (GET form, URL is the state, works without JS): Type, Status, Priority (multi-checkbox, OR within, AND across), Labels (both kinds, OR within the set, grouped Team / project labels), Assignee (Anyone, Me, Unassigned, user), Reporter (Anyone, Me, user), Project (multi, up to 6), Milestone (None, or one milestone; the picker lists milestones only when exactly one project is chosen, otherwise only "None"), Created from/to, Updated from/to (calendar dates in `TEAM_TIME_ZONE`, inclusive; converted to a half-open millisecond range). Unknown or invalid values are dropped, never an error; the page then says "Some filters were ignored".
- **Sort**: `updated` (default, desc), `created`, `priority`, `due` (no due date last), `dir`. Tie-break `id` for a stable order.
- **Pagination**: 50 per page, `page` 1..200 (offset at most 10 000). The total is **capped**: `select count(*) from (… limit 10001)`, shown "10,000+" beyond. "Showing a-b of N". Prev/Next links keep filters.
- **Columns (desktop)**: Key-N with type icon, Title with label chips (both kinds), Project key, Status, Priority, Assignee, Updated. Reporter and created date show on the task.
- **Phone**: the table becomes stacked rows (title on top, then chips: type, status, priority, project key, assignee initials, due). Filters live in a bottom **sheet** opened by a "Filters (N)" button; active filters appear as removable chips above the list. Sort is a select in the header. Row checkbox target and every button at least 44x44 px.
- **Bulk bar**: appears when at least one row is selected (sticky above the tab bar, padded by `--sai-bottom`).
- **Saved views**: picker plus "Save view" (name 1-40).
- **Search text** is not a filter here; a link "Search text instead" goes to `/search`.

### Server modules

- `src/lib/server/issues/query.ts`: `parseIssueFilters(params, viewer)`, `listIssues(db, filters, sort, page, viewerId)`, `issueFilterOptions(...)`. Pure parser in `src/lib/shared` where it has no DB use (date range, key list).
- `src/lib/server/issues/repo.ts`: `reportIssue` (wraps `createTask`), `lastProjectOf(db, userId)`.
- `src/lib/server/pm/team-labels.ts`: `listTeamLabels`, `createTeamLabel`, `updateTeamLabel`, `deleteTeamLabel`, `teamLabelUsage` (grouped count), `teamLabelsForTasksQuery`.
- Extend: `pm/labels.ts` `setTaskLabels(db, projectId, taskId, {labelIds, teamLabelIds}, at)` (one batch: assert task live + project active + every project id live in this project + every team id live + total <= 10; delete unlisted links of **both** tables; insert-select both), `labelsForTasksQuery` returns both kinds with a `scope: 'project'|'team'` field (second statement in the same batch), `pm/bulk.ts` (cap guard counts both tables; `type` change), `pm/views.ts` + `pm/query.ts` (issues scope), `tasks/validation.ts` (`type` parser in `PARSERS`/`TASK_FIELDS`, label filter semi-join over both tables), `tasks/repo.ts` (`createTask` type + labels + client id; row columns select `type`), `search/repo.ts`.
- Label filter SQL shape for all lists: `tasks.id IN (SELECT task_id FROM task_labels tl JOIN labels l … WHERE tl.label_id IN (json_each) AND l.deleted_at IS NULL UNION SELECT task_id FROM task_team_labels … JOIN team_labels … )`. A semi-join, not a correlated EXISTS per row, so a selective label drives the query from the link index. All id lists bound as one JSON parameter (100-parameter limit).

## Limits (`ISSUE_LIMITS`, one exported const; client `maxlength` mirrors them)

| Limit | Value |
|---|---|
| Task types | 4 |
| Team labels, live | 100; name 1-30, single line, unique ignoring case; colour in `LABEL_COLORS` |
| Labels per task, project + team combined | 10 |
| Page size / max page / count cap | 50 / 200 / 10 001 |
| Filter sizes | types 4, statuses 6, priorities 5, labels 8, projects 6, one assignee, one reporter, one milestone |
| Date filters | `YYYY-MM-DD`, 2000-01-01..2100-12-31 |
| Saved issues views | 20 per user; name 1-40; query <= 1 000 chars |
| Bulk | 100 ids, one batch; notification burst 10 |
| Report form | title 1-200, description 0-20 000, form body `LIMITS.formBodyMax`, 20 reports per user per minute |
| Label options on `/issues` | team labels (<= 100) + project labels (<= 300, key shown; "Narrow by project to see more") |
| Project picker | active projects, `LIMITS.projectListMax` (500) |

## Authorization per action

| Action | Rule |
|---|---|
| `/issues` load, saved view open, `/issues/new` load, `/issues/labels` | `requireUser`; every active member sees every project's tasks live |
| Report an issue (POST) | `requireUser`; project must be active and live (else 409 / 404, nothing written) |
| Change type, apply/remove labels, edit task | any active user; project active (RB-01 rule) |
| Bulk on `/issues` | any active user; every task in an active project; all-or-nothing |
| Save / open / delete an issues view | own views only; another user's id gives 404 |
| `/admin/labels` load and every action (create, rename, recolour, delete) | `requireAdmin` (member 403, signed-out redirect to sign-in, deactivated refused) |
| Apply a team label | any active user (Owner decision O1) |
| Project labels | unchanged from RB-08 |

Hidden and missing ids give the same answer. A label id in a form is always resolved in SQL against its scope (project id for project labels, live row for team labels).

## Concurrency (D1: `db.batch`, no interactive transactions)

- **Team label create**: `INSERT … SELECT … WHERE (select count(*) from team_labels where deleted_at is null) < 100`; the partial unique `team_labels_name_uq` decides a name clash (`isUniqueViolation` -> "That label already exists"). 20 concurrent creates at 99 live: exactly one succeeds.
- **Team label update**: `WHERE id AND deleted_at IS NULL AND updated_at = :expected`; 0 rows -> follow-up read: gone (404), stale (409 "changed meanwhile"), duplicate name (field error). **Delete**: soft; links stay but every read filters `team_labels.deleted_at IS NULL`; the name becomes reusable; already deleted counts as done. A confirm step shows "Used on N tasks" (computed from live tasks) before deleting; there is no undo (Owner decision O7).
- **Set task labels** (both kinds): one batch, assertion first; any invalid id (deleted, other project's project label) rolls the whole batch back. Two tabs, different sets: last write wins (a tag set has no merge), documented. `tasks.updated_at` not bumped (RB-08 decision 8). Concurrent bulk add and set-labels: each statement is serialised by D1; the cap check sits inside each INSERT, so the total never exceeds 10 (test: 20 concurrent adds against a task at 9).
- **Task type change**: normal `patch` with the `updated_at = :expected` guard and conflict screen. Type changes bump `updated_at` and are not an FTS event.
- **Report**: create batch as RB-01 (counter bump + insert + label inserts), retry <= 3 on number collision; client `submissionId` as primary key makes a double submit idempotent.
- **Bulk**: see D6.
- **Saved view create**: unique partial index is the arbiter; the 20-cap is a count inside the INSERT.
- **Archive during use**: every write re-checks "project active" in SQL (existing `projectActive`).

## States

- `/issues`: skeleton rows while navigating; empty "No issues yet" with a Report button; filtered empty "No issues match these filters" with Clear filters; load error banner with Retry; filters-ignored note; "10,000+" total; archived switch; bulk bar states (N selected, Apply disabled until a change is chosen, saving spinner, success toast "N issues updated" only after the server confirms, 404/409 messages above); saved-view empty "No saved views".
- `/issues/new`: field errors under inputs (`aria-describedby`), form banner for 409/429/500, no projects ("Create a project first" link), saving state, success redirect plus toast, label-load failure falls back to team labels only with a note.
- `/admin/labels`: empty "No team labels yet", limit message at 100, per-row errors, delete confirm with usage count, saving and success states.
- Task detail: type select saving/conflict states as the other fields.

## Mobile and layout (402x874, 440x956, 360 px)

- `viewport-fit=cover`; safe areas only through `--sai-*`. No page-level horizontal scroll at any of the three widths (the table collapses to rows; long titles wrap; chips wrap).
- Filters in a bottom sheet (kit `Dialog`) with its own scroll, sticky "Show N results" and "Clear" at the foot, padded by `--sai-bottom`; focus returns to the opener.
- Tap targets >= 44 px for rows' checkboxes, filter button, chips' remove buttons, pagination, sheet controls, type select. Inputs >= 16 px (no iOS zoom). Report form: single column, sticky submit above the tab bar.
- Extend the Playwright viewport spec with `/issues`, `/issues/new`, `/admin/labels` at the three widths (assert `scrollWidth <= innerWidth`, measure tap targets).

## Performance budget (statement count per page; counted in tests with the existing query counter)

| Page | Round trips after auth | Statements | Notes |
|---|---|---|---|
| `/issues` | 1 (2 with one project filter) | <= 10 (11) | rows, capped count, project labels of page rows, team labels of page rows, project picker, active users, team labels, project label options, saved views (+ milestones for one project). Independent of row count |
| `/issues/new` | 1 | <= 5 | active projects, team labels, project labels of the chosen project, last project, (user) |
| Report POST | 2 | <= 8 | counter read + create batch (counter, insert, label inserts); retry <= 3 |
| `/issues` bulk | 2 | <= 9 | one batch incl. assert, <= 100 ids |
| `/admin/labels` | 1 | <= 2 | list <= 100, usage counts |
| Project list / board | unchanged round trips | +1 statement | team labels for the page's tasks |
| Task detail | unchanged round trips | +2 statements | task team labels, team label options |

Plus: each single filter and the default sort must show an index (not a full table scan of `tasks`) in `EXPLAIN QUERY PLAN`; `priority` and `due` sorts scan the matching rows (acceptable; test with 5 000 live tasks in 20 projects stays under the budget and finishes in a test-time bound). Design assumption: up to about 20 000 live tasks.

## Acceptance criteria

Verification tags: [A] Automated (Vitest, local D1), [P] Pass (real runtime or browser check), [M] manual.

Authorization and safety
1. [A] Signed-out requests to `/issues`, `/issues/new`, `/issues/labels`, `/issues/views/[id]`, `/admin/labels` and every action are refused; a deactivated user is refused too. `/admin/labels` and its actions give a member 403.
2. [A] A member cannot create, rename, recolour or delete a team label even by posting the action directly; nothing changes.
3. [A] Another user's issues view id gives 404 on open and delete; an issues view id on `/projects/KEY/views/[id]` gives 404 and a project view id on `/issues/views/[id]` gives 404.
4. [A] Task, label, project and view ids from another scope are "not found", never accepted (project label of another project, deleted team label, archived project's task in bulk).

Task type
5. [A] After `0012`, every existing task reads `type = 'task'`, row count and ids unchanged, `integrity_check` ok, `foreign_key_check` empty, FTS search results identical before and after; the `tasks_fts_*` triggers still exist.
6. [A] A task can be created and patched to each of the four types; an unknown type is a field error; the DB CHECK rejects a raw insert of `epic`.
7. [A] Changing only `type` does not change `tasks_fts` content (FTS rowcount and a match unchanged); title edits still re-index.
8. [A] Type shows on `/issues`, project list, board cards (non-task only), My tasks, `/search` task hits, task detail; type is editable on the task detail with the stale-version conflict path.

Team labels
9. [A] Admin creates "Urgent care" (blue); "urgent CARE" is refused; 101st is refused; 31-char name and bad colour are refused; deleting frees the name; 20 concurrent creates at 99 leave exactly 100.
10. [A] A task carries team and project labels together; the 11th label of either kind is refused with nothing changed; concurrent adds at 9 end at exactly 10.
11. [A] Deleting a team label removes it from `/issues` filters, chips, pickers and counts on all projects; applying a deleted team label is refused.
12. [A] The label filter on `/issues`, the project list and the board matches tasks with a project label or a team label (OR inside the set), composes with the other filters, and drops unknown ids.
13. [A] RB-08 label tests all pass unchanged except the ones updated for the two-kind `setTaskLabels` signature; project labels still cannot cross projects.
14. [A] Label chip text, names and view names render as plain text (no `{@html}`); team chips carry a text/icon marker, colour is never the only signal.

Issues page
15. [A] `/issues` lists live tasks from all projects; soft-deleted tasks and tasks of deleted projects never appear; archived projects' tasks appear only with `archived=1`.
16. [A] Each filter (type, status, priority, label, assignee, reporter, project, milestone, created range, updated range) returns exactly the expected rows, and combinations AND across and OR within; date bounds are inclusive in `TEAM_TIME_ZONE` including midnight edges.
17. [A] Sorting by updated, created, priority and due is stable (ties by id); page 3 of a 120-row set holds rows 101-120; page 201 and `page=abc` fall back to page 1; the total caps at "10,000+" (seed 10 001).
18. [A] Invalid filter values (unknown type, bad uuid, `2026-02-30`, 7 projects) are dropped without a 500 and the page says some filters were ignored.
19. [A] Saved issues view: save from the current filters; opening restores them; stored `query` holds only whitelisted keys (`x=<script>` and `sort=;drop` dropped, `page` dropped), worst case <= 1 000 chars; 21st view refused; duplicate name refused; a view naming a deleted project's key still opens with a notice.
20. [A] Migration test: `saved_views` rows from `0010` survive the rebuild byte for byte (ids, names, queries, deleted rows), both indexes exist, a project view with NULL `project_id` and an issues view with a project are both rejected by the CHECK, `foreign_key_check` empty.
21. [A] Statement budgets in the table above hold, and are the same with 10 and with 500 tasks; query plans use indexes for the default sort and each single filter.

Bulk
22. [A] Bulk of 100 tasks across 5 projects (status, priority, type, assignee, due date, add team label) succeeds in one request; 101 is refused; any missing, deleted or archived-project task fails the whole request with nothing changed (injected deleted task, injected archived project).
23. [A] Bulk status change places each task at the bottom of its own project's target column in ascending number order and sets/clears `completed_at` by the RB-01 rule.
24. [A] Bulk assign notifies only tasks whose assignee changed, never self, at most 10 per request; bulk add respects the 10-label combined cap and reports skipped tasks; milestone and project-label fields are rejected if posted to the `/issues` bulk action.
25. [A] A 100-id bulk and a 300-row page stay under D1's 100-parameter limit (ids bound as JSON).

Report an issue
26. [A] A member reports a Bug in an active project: a normal task exists with a fresh number, `created_by` = reporter, `type = bug`, status `backlog` (default), chosen priority and labels (team + project, <= 10), Markdown description stored raw and rendered through `renderMarkdown` (script, `<img onerror>`, `javascript:` inert).
27. [A] Archived or deleted project: refused (409/404), nothing inserted. Project picker lists only active projects.
28. [A] Title 0 or 201 chars, description 20 001 chars, unknown type/priority, >10 labels, project label of another project: field errors, nothing inserted. Boundary values accepted.
29. [A] Submitting the same `submissionId` twice (also 10 concurrent) creates exactly one task; a foreign id is a validation error. 10 concurrent reports in one project get numbers 1..10 with no gaps.
30. [A] The 21st report within a minute by one user answers 429 and inserts nothing.
31. [A] Task and label links succeed or fail together; a label deleted mid-flight is skipped and reported, never half-applied.
32. [P] With JavaScript disabled the form submits and shows field errors and success; with JavaScript, changing the project swaps the project labels and keeps typed text.

Navigation, release, other
33. [A] `nav.ts`: Issues is item 3 of section 0, appears once, is not in `TAB_ITEMS`, is listed first after Report in `moreItems()`; Report is exported as `REPORT_ISSUE` and rendered as a sidebar-head icon button and the first More row; sidebar item count and sections unchanged otherwise.
34. [A] Release note `src/lib/content/releases/0.5.0.md` (front matter `version: 0.5.0`, date, title) and `package.json` / `APP_VERSION` set to 0.5.0 so the RB-11 deploy guard passes. Engineer checks the guard allows 0.5.0 if 0.4.0 has not shipped; otherwise ship in order.
35. [P] Viewport spec: `/issues`, `/issues/new`, `/admin/labels` at 360, 402 and 440 px: no horizontal page scroll, tap targets >= 44 px, filter sheet opens, closes and returns focus, bulk bar clears the tab bar and home indicator.
36. [M] Dark mode: team and project chips AA-readable; keyboard-only run of filters, bulk and Report; screen reader labels on icon-only buttons.
37. [A] All RB-01, RB-02, RB-03 and RB-08 tests still pass; FTS consistency after create, edit, delete and restore of a typed task; Markdown XSS vectors inert; logs hold ids and counts only, never titles, descriptions or label names.
38. [A] `npm run check`, lint, test, build (`npm run gates`) pass. `ENGINEERING_CHECKLIST.md` probes run: concurrency (20 concurrent at each cap), two tabs, roles crawl (signed-out, member, admin, deactivated), soft delete, 360 px, no-JS forms.

## Test plan

Unit: `parseIssueFilters` table (limits, injection, dates, tz edges), `canonicalizeQuery('issues', …)` (whitelist, worst-case length), type parser, label-cap helper, `nav.ts`.
Integration (`openLocalD1`, `fakeEvent`; extend `test/helpers/seed-tasks.ts` with types, team labels, a 5 000-task / 20-project set and an archived project): migration test applying 0000..0012 over seeded tasks, labels and saved views; filter matrix; sort and pagination; query-count and `EXPLAIN QUERY PLAN` tests; team label races; combined-cap race; bulk atomicity, cross-project positions, notification matrix; report double-submit and rate limit; saved-view scopes and cross-scope 404s; permission matrix (signed-out, member, admin, deactivated).
Browser (Playwright, outside `gates`): viewport spec above; no-JS report flow.
Red team focus: cross-scope label ids, view id scoping, existence oracle on ids, filter parameter abuse (huge lists, SQL-like input), unbounded scans, bulk across projects, `submissionId` hijack, rate limit, Markdown in the report body, admin-only enforcement by direct POST.

## Out of scope

Custom types or a type per project; triage queues, SLAs, severity fields; a separate `reporter` column or "file on behalf of"; e-mail or inbound issue intake; public issue forms; duplicate detection; free-text search inside `/issues` (use `/search`); type filter on project list and board; cross-project milestones; milestone or project-label bulk across projects; moving a task between projects; "select all matching" bulk; team-shared saved views; label descriptions, label groups, label automation; restoring a deleted team label; per-label permissions; Report-an-issue as a dialog on every page (it is a page; link from anywhere); CSV export; attachments on the Report form (add them on the task); keyset pagination beyond 10 000 rows.

## Prerequisites

None: no new variables, bindings or secrets. Uses `TEAM_TIME_ZONE` (already set) for date filters.

## Architecture notes

New trees: `src/routes/(app)/issues/**`, `src/routes/(app)/admin/labels/**`, `src/lib/server/issues/**`, `src/lib/ui/issues/**` (IssueTable, IssueFilters sheet, TypeBadge, TypeSelect, ReportForm pieces). Reuse: `newId`, `isUniqueViolation`, `errorLabel`, `batchAssert`/`isBatchAssertFailure`, `projectActive`, `completedAtFor`, `POSITION_STEP`, `assignedNotificationStatement`, `LIMITS`, `PM_LIMITS`, `LabelChip` (add a `scope` prop), `TaskLabelsField`, `BulkBar` (parameterised by allowed fields), `ViewPicker`, `DescriptionField`, kit `Dialog`/`Select`/`Table`, the safe-return helper and the form-body guard. Do not copy RB-08 bulk; extract the shared core. Do not touch the RB-03 comment and RB-04 attachment slots. Deploy: the `saved_views` rebuild is not destructive (data copied, verified by test); record the D1 Time Travel bookmark as usual before applying remotely.

## Tracker impact

New `docs/TASKS.md` item: "RB-12 Issues and team labels: task types, `/issues` with filters, saved views and bulk edit, Report an issue, team labels at `/admin/labels` (Claude)". Does not close an existing item; the open "UI polish" item is unrelated. `docs/ACCEPTANCE.md` rows to add: `0012` migration keeps tasks, FTS and saved views (Automated); combined 10-label cap race (Automated); cross-project bulk atomicity (Automated); viewport spec for the three new pages (Pass).

## Owner decisions (proposed defaults)

| # | Decision | Proposed default |
|---|---|---|
| O1 | Who creates team labels | **Admins only.** Any member can apply them and see them. Keeps one clean workspace vocabulary; members still make project labels |
| O2 | Task types | **Task, Bug, Feature request, Improvement** (fixed list, not editable per project) |
| O3 | Status of a reported issue | **Backlog** (a "to be looked at" inbox; people move it to To do). Alternative: To do |
| O4 | Reporter | `created_by` is the reporter; no new column |
| O5 | Report an issue into archived projects | **No.** Archived projects are frozen (RB-01); picker lists active projects only |
| O6 | Combined label cap | **10 per task, project + team together** (RB-08's number kept) |
| O7 | Team label delete | Soft delete with a confirm showing "Used on N tasks"; **no restore** in this pass (same as RB-08 labels). Alternative: add a restore list |
| O8 | Issues in the phone tab bar | **No.** Tab bar stays Home, My tasks, Projects, KB; Issues and Report are the first rows of More, and Report is also a button on `/issues`. Alternative: swap Issues in for KB |
| O9 | Saved issue views | **Personal**, max 20 per user (team-shared views later) |
| O10 | Cross-project bulk fields | Status, priority, type, assignee, due date, team label add/remove. Milestone and project labels only in the project list |
| O11 | Default sort of `/issues` | **Recently updated first** |
| O12 | Team-label and project-label name clash | **Allowed**; team chips carry a "Team" marker. Alternative: refuse a team name already used as a project label (racy, not recommended) |


## Owner answers (2026-10-26)

The owner chose the recommended options (issue tracker; team-wide labels). Every owner decision O1–O12 takes its
proposed default.
