# RB-18 Grouped table, swimlanes and view tabs — PRD

Request: owner, 2026-10-26, tracker roadmap (`docs/features/rb-15-tracker-roadmap.md`, Phase A item 3). RB-18 is
proposed here.

Risk tier: **Medium**. Reasons: one nullable column on the leaf table `saved_views` (`ADD COLUMN`, no rebuild),
read-only query changes (grouped counts, windowed rows), board rendering with lanes, saved-view actions. No change to
how tasks are written. Pipeline: engineer + QA (red team optional: query-parameter abuse and view scoping only).

Depends on: RB-01, RB-08 (list, board, saved views), **RB-12 merged** (`/issues`, rebuilt `saved_views` with nullable
`project_id`), RB-16 (parent dimension) and RB-17 (cycle dimension); if either is not merged, its group key is left
out and added by that feature. Migration **`0018_view_tabs.sql`**. Version **0.10.0**.

## Goal

The project list is a fixed-column table sorted one way; the board is six columns of everyone's cards. People ask
"what is each person doing, by status?", "which bugs are open per milestone?", "show me my two favourite filters as
tabs". This increment adds **two-level grouping** to the project table and `/issues`, **a column chooser**, **swimlanes**
on the board, and **pinned saved views shown as tabs**, all in the URL so every arrangement is a shareable link that
works without JavaScript.

## Current behaviour this builds on (cite before changing)

- Project page load: `src/routes/(app)/projects/[key]/+page.server.ts` (`view=list|board`, `parseFilters`,
  `parseSort`, `parsePage`, saved views via `listViews`, RB-08 bulk action).
- `tasks/repo.ts:160` `listTasks` (page of 50 + count in one batch), `:199` `boardTasks` (per-status cap
  `LIMITS.boardColumnMax` 100 and grouped counts), `filterConditions` :114.
- `tasks/validation.ts`: `TaskFilters` :233, `parseFilters` :258, `parseSort` :282, `filtersQuery` :300.
- `pm/query.ts:11` `canonicalizeQuery` (fixed key order, whitelist, `PM_LIMITS.viewQueryMax` 500); RB-12 adds kind
  `issues` (1 000).
- `pm/views.ts`: `listViews` :30, `getView` :46, `saveView` :67, `deleteView` :116 (create and delete only, no
  update). `saved_views` DDL: `migrations/0010_pm_plus.sql:52-67`, rebuilt by RB-12 `0012` (nullable `project_id`,
  kind `issues`, two partial unique indexes). No length CHECK on `query`.
- UI: `src/lib/ui/tasks/TaskTable.svelte`, `Board.svelte` (pointer and keyboard drag, no-JS move forms, `?/move`),
  `FilterBar.svelte`, `src/lib/ui/pm/ViewPicker.svelte`, `BulkBar.svelte`; kit `Tabs`, `Table`, `DropdownMenu`.
- `pm/extras.ts:16` `taskExtras` (label chips, checklist progress; RB-16 and RB-17 add progress, blocked, cycle).

## Design decisions (the CTO calls; owner can override under Owner decisions)

### D1. Group keys

| Key | Applies to | Order of groups | Empty group label |
|---|---|---|---|
| `status` | list, issues | `TASK_STATUSES` order (column labels from RB-08 `project_columns` on a project) | — |
| `priority` | list, issues | urgent → none | "No priority" |
| `assignee` | list, issues | name, "Unassigned" last | "Unassigned" |
| `type` | list, issues | `TASK_TYPES` order (RB-12) | — |
| `milestone` | list | due date, then name; "No milestone" last | "No milestone" |
| `cycle` | list | active, upcoming, ended, completed (RB-17) | "No cycle" |
| `parent` | list | parent number; "No parent" last (RB-16; top-level tasks that have sub-issues lead their own group) | "No parent" |
| `label` | list, issues | name; "No label" last. A task with several labels appears in each of its groups (stated above the table) | "No label" |
| `project` | issues | project key | — |

`group` is level 1, `sub` level 2 (must differ from `group`; `label` allowed at one level only). Board lanes take
`lane` with keys `assignee`, `priority`, `type`, `milestone`, `cycle`, `parent` (status is the column, so not a lane;
label is not a lane because a card would repeat).

### D2. Grouped list: bounded, two queries

When `group` is set the list is not paginated (`page` is ignored):
1. **Counts**: `SELECT g1, g2, count(*) … WHERE <filters> GROUP BY g1, g2` over the whole filtered set (bounded by
   the number of groups, not rows).
2. **Rows**: `SELECT … , row_number() OVER (PARTITION BY g1, g2 ORDER BY <sort>, id) AS rn … WHERE <filters>` wrapped
   in `WHERE rn <= 25`, then `LIMIT 500`.
Caps: **50 level-1 groups**, **20 sub-groups per group**, **25 rows per (sub-)group**, **500 rows per page**. A group with
more rows shows "Show all N" linking to the flat list filtered to that group value (e.g. `assignee=<id>&status=todo`,
built by `filtersQuery`). Extra groups beyond the caps show "N more groups" with a link that adds the group value as
a filter where the key is filterable, else a note. Window functions are standard SQLite (3.25+); the engineer
confirms D1 supports them against the current D1 docs and proves it in a local D1 test before relying on them.
Label grouping joins the label links (project and team labels, RB-12) and counts per label.

Each group renders as `<details open>` with a heading row (`h3`/`h4`, count, collapse control). Collapsed state is a
per-viewer convenience in `localStorage` (try/catch; the page works without it). Bulk selection (RB-08 / RB-12) works
across groups; the 100-id cap is unchanged; a task shown in two label groups counts once.

### D3. Column chooser

`cols` lists visible columns in a canonical order from a whitelist: `key` and `title` always; optional `status`,
`priority`, `assignee`, `due`, `labels`, `milestone`, `cycle`, `type`, `parent`, `progress` (checklist and sub-issues),
`updated`, `created`; on `/issues` also `project`, `reporter`. Absent `cols` = today's default set. The chooser is a
kit `DropdownMenu` of checkboxes with JS, and a `<details>` checkbox list submitting a GET form without JS. On phones
(stacked rows) the chosen columns decide which chips appear.

### D4. Board swimlanes

`view=board&lane=<key>`: one lane per value (same ordering as D1), each lane a row of the visible status columns.
Caps: **20 lanes**, **50 cards per lane-column**; column headers keep the RB-08 WIP chip computed over the whole column
(all lanes). Moving a card: drag, keyboard and no-JS move forms work **within a lane** (status and position change as
today); dropping into another lane is not offered (the drop target is only the card's lane), because a lane change
edits a different field. Lanes are `<details>` sections, collapsible.

### D5. View tabs (pinned saved views)

- `saved_views.tab_position real` (NULL = not pinned). A user pins up to **8 views per scope** (one project, or the
  `/issues` scope). Tabs render above the list/board after a fixed first tab "All" (the unfiltered view).
- Actions on the project page and `/issues`: `viewPin`, `viewUnpin`, `viewMove` (left/right buttons; position = the
  midpoint between neighbours, RB-01 position helper), and new `viewUpdate` (overwrite an own view's `query` with the
  current canonical URL query, guarded by `updated_at = :expected`). `saveView` gets an optional "Pin as tab" checkbox.
- The active tab is the pinned view whose stored query equals the canonical form of the current URL; when the URL
  differs from the open tab's view, the tab shows a "modified" marker (text + icon) and an "Update view" button.
- Views stay personal (RB-08 decision 6, RB-12 O9). Team-shared tabs are Phase B.

### D6. Saved query size

New keys add up to ~260 characters to the worst case (`cols` with 15 names, `group`, `sub`, `lane`). Raise the
application caps: `PM_LIMITS.viewQueryMax` **500 → 800** and RB-12 `issueViewQueryMax` **1 000 → 1 400**, each with a
test that builds the worst-case canonical query and asserts it fits. The DB has no length constraint, so no migration
is needed for this.

## Scope

### Migration `0018_view_tabs.sql`

```
ALTER TABLE saved_views ADD COLUMN tab_position real;
CREATE INDEX saved_views_tabs_idx ON saved_views(user_id, project_id, tab_position)
  WHERE tab_position IS NOT NULL AND deleted_at IS NULL;
```

Additive, leaf table, no FTS. Applies after RB-12's rebuild (`0012`); the migration test runs 0000..0018 and checks
every existing view keeps `tab_position` NULL and its query byte for byte. `schema.ts`, snapshot (next free file name;
journal tag `0018_view_tabs`).

### Routes

| Route | Change |
|---|---|
| `projects/[key]` (list) | `group`, `sub`, `cols`; grouped rendering; tabs; actions `viewPin`, `viewUnpin`, `viewMove`, `viewUpdate` (plus RB-08 `saveView` with pin) |
| `projects/[key]?view=board` | `lane`; lane rendering; tabs |
| `issues` (RB-12) | `group`, `sub` (incl. `project`), `cols`; tabs; same view actions for the issues scope |
| `projects/[key]/views/[id]`, `issues/views/[id]` | unchanged openers (redirect to the stored query) |

### Server modules

- New `src/lib/server/pm/grouping.ts`: `GROUP_KEYS`, `parseGrouping(params, scope)`, `groupExpression(key)` (SQL
  per key, compile-time constants only, never built from input), `groupedTasks(db, scope, filters, grouping, sort,
  viewerId)` (counts + windowed rows in one batch), `boardLanes(db, projectId, filters, lane)`.
- New pure `src/lib/shared/columns.ts`: `COLUMN_KEYS`, `parseColumns(params, scope)`, `DEFAULT_COLUMNS`.
- Extend, never copy: `tasks/repo.ts` (`boardTasks` takes an optional lane and per-lane cap; `filterConditions`
  reused), RB-12 `issues/query.ts` (`listIssues` grouped variant shares `grouping.ts`), `pm/query.ts`
  (`group`, `sub`, `lane`, `cols` keys; caps D6), `pm/views.ts` (`pinView`, `unpinView`, `moveView`, `updateView`,
  `listViews` returns `tabPosition`), `pm/validation.ts` (limits).
- UI: `src/lib/ui/pm/GroupedTable.svelte` (wraps `TaskTable` rows per group), `GroupHeader.svelte`,
  `ColumnChooser.svelte`, `GroupingControls.svelte` (Group by / Then by / Lanes selects), `ViewTabs.svelte`;
  `Board.svelte` gains lanes (drop targets scoped to the lane).

## Limits

| Limit | Value |
|---|---|
| Group levels | 2 (list, issues); 1 lane level (board) |
| Level-1 groups / sub-groups per group | 50 / 20 |
| Rows per (sub-)group / rows per grouped page | 25 / 500 |
| Lanes / cards per lane-column | 20 / 50 |
| Columns | whitelist of 13 (project) or 15 (issues) |
| Pinned tabs per user per scope | 8 |
| Saved query | 800 (project views), 1 400 (issue views) |

## Authorization per action

| Action | Rule |
|---|---|
| Grouped list, board lanes, column choice | `requireUser`; every active user |
| `viewPin`, `viewUnpin`, `viewMove`, `viewUpdate` | `requireUser`; own live view only, in the scope of the route (project id from the URL, or the issues scope); another user's or another scope's view id gives 404 |
| Board moves within a lane | unchanged RB-01 `?/move` rules (project active) |

## Concurrency

- **Pin**: `UPDATE saved_views SET tab_position = :pos WHERE id = :id AND user_id = :u AND <scope> AND deleted_at IS
  NULL AND (SELECT count(*) pinned in scope) < 8`. Test: 20 concurrent pins at 7 → exactly one.
- **Move**: guarded on the row; two concurrent moves may tie positions; reads order by `(tab_position, id)` so ties
  are stable; a renumber (as RB-01 `renumberColumn`) runs when the gap falls below the minimum.
- **Update view**: `WHERE … AND updated_at = :expected`; 0 rows → 404 or 409 "changed meanwhile".
- **Unpin / delete**: idempotent; a deleted view drops out of tabs (reads filter `deleted_at IS NULL`).
- Grouped reads are two statements in one batch, so counts and rows come from the same snapshot.

## States

- Grouped list: skeleton while navigating; empty "No tasks match" (no groups); empty groups are not shown;
  "Show all N" per capped group; "N more groups" note; label-duplication note; errors banner with Retry.
- Column chooser: saving is a navigation (URL), no server write; "Reset columns".
- Board lanes: empty lane hidden; "+N more" per capped lane-column; "Lanes capped at 20" note; drag outside the lane
  shows no drop marker.
- Tabs: no pinned views (only "All"); limit message at 8; modified marker; update saving/success/conflict states; pin
  and unpin success toasts only after the server confirms.

## Mobile layout (402×874, 440×956, 360 px)

- Grouping controls and column chooser live in the existing filter sheet (kit `Dialog` as a bottom sheet, RB-12
  pattern) behind "View options"; selects ≥ 44 px tall, ≥ 16 px text.
- Grouped list: groups stack; group headers are sticky below the top bar (not under the Dynamic Island: offset by
  `--sai-top`), each header ≥ 44 px; rows are the stacked RB-12 row layout.
- Board with lanes below 768 px: one lane at a time, chosen by a lane select; inside it the status columns use the
  existing horizontal column scroller **inside its container** (no page-level horizontal scroll).
- Tabs: a horizontally scrollable tab strip inside its own container with fade edges, each tab ≥ 44 px; the active
  tab scrolls into view; pin/move buttons in a per-tab `DropdownMenu`.
- Safe areas only via `--sai-*`. Viewport spec extended: grouped list (two levels), board with lanes, tab strip with
  8 tabs at 360, 402 and 440 px; assert `scrollWidth <= innerWidth` and tap target sizes.

## Performance budget

| Page | Round trips after auth | Statements |
|---|---|---|
| Grouped project list | 1 | ≤ 10 (counts, windowed rows, `taskExtras` ≤ 4, users, labels, milestones/cycles, views) |
| Board with lanes | 1 | today's count + 1 (lane counts) |
| Grouped `/issues` | 1 (2 with one project) | RB-12 budget + 1 |
| View actions | 1 | ≤ 2 |

Statement counts are independent of the number of tasks (query-counter test with 10 and 5 000 tasks). Plans: each
group key's expression uses an existing index or a bounded scan of the filtered set; the windowed query never sorts
more than the filtered set.

## Acceptance criteria

Tags: [A] Automated, [P] Pass, [M] manual.

1. [A] Signed-out and deactivated requests to every changed page and view action are refused.
2. [A] Another user's view id and a view of another scope give 404 for pin, unpin, move and update; nothing changes.
3. [A] `group`, `sub`, `lane`, `cols` accept only whitelisted values; `group=sub` duplicates, unknown keys,
   `group=label&sub=label`, SQL-like text and 1 000 repeated values are dropped without a 500, and the page says
   "Some options were ignored"; group SQL is built only from constants (code review + test).
4. [A] Each group key returns groups in the stated order with correct counts that equal the flat list's total for
   the same filters (label grouping: sum of label groups ≥ total, and "No label" + labelled = total distinct).
5. [A] Two-level grouping caps hold (51st group, 21st sub-group, 26th row, 501st row) and each capped group links to
   a flat list that returns exactly that group's tasks.
6. [A] Sorting inside groups follows `sort`/`dir` with ties by id; `page` is ignored in grouped mode.
7. [A] Bulk selection across groups updates each selected task once; the 100 cap is unchanged.
8. [A] Board lanes: cards appear in the right lane and column; caps 20/50 hold; the WIP chip counts the whole column;
   a move within a lane updates status and position as before; a move posted with a lane-changing intent is not
   possible (the form carries no lane field) and RB-01 move tests pass unchanged.
9. [A] `cols` hides and shows columns; absent `cols` gives today's columns; stacked phone rows show the chosen chips.
10. [A] After `0018`, every existing view has `tab_position` NULL and an identical query; `integrity_check` ok.
11. [A] Pin up to 8 per scope; the 9th is refused; 20 concurrent pins at 7 leave exactly 8; move left/right reorders
    and survives reload; unpin removes the tab; deleting a pinned view removes its tab.
12. [A] `viewUpdate` stores the canonical form of the current URL (whitelisted keys only) for an own view; a stale
    version gives 409.
13. [A] Worst-case canonical queries fit 800 (project) and 1 400 (issues); older stored queries still open.
14. [A] Statement budgets hold with 10 and 5 000 tasks; windowed query verified on local D1.
15. [P] Without JavaScript: grouping, column choice (GET form), pin/unpin/move/update work; with JavaScript: column
    menu and lane drag by pointer and keyboard.
16. [P] Viewport spec at 360, 402, 440 px: no page-level horizontal scroll; sticky headers clear the Dynamic Island;
    tap targets ≥ 44 px.
17. [M] Keyboard: tab strip arrow keys, group collapse with Enter/Space, headings in order; dark mode AA.
18. [A] Release note `0.10.0.md`; versions bumped; all RB-01, RB-08, RB-12, RB-16, RB-17 tests pass; `npm run gates`
    passes; checklist probes listed.

## Test plan

Unit: `parseGrouping`, `parseColumns`, canonicaliser worst cases, group ordering comparators, tab position midpoint.
Integration: migration test 0000..0018; every group key on a 500-task seed with labels, milestones, cycles, parents,
types; caps; count/total equality; label duplication; board lanes and move; view action matrix (own, other user,
other scope, deleted); pin race; query counts and plans.
Browser: viewport spec; no-JS grouping and tabs; keyboard lane drag.

## Out of scope

Drag a card between lanes; drag to reorder groups; grouping by custom fields (RB-23); aggregates per group other
than counts (sums of estimates); inline cell editing in the table; team-shared tabs; per-tab default for the whole
team; exporting a grouped table; grouping My tasks; more than two levels.

## Prerequisites

None.

## Architecture notes

Reuse `filterConditions`, `parseFilters`, `filtersQuery`, `canonicalizeQuery`, `taskExtras`, `TaskTable`,
`Board`, `BulkBar`, `ViewPicker` (becomes the "More views" menu next to the tabs), kit `Tabs`, `DropdownMenu`,
`Dialog`. Conflicts with RB-12: extends `/issues` load, `issues/query.ts`, `canonicalizeQuery('issues', …)` and the
issues view actions; raises `issueViewQueryMax`; must not rebuild `saved_views` again. The open TASKS item "List/Board
switch twice" should already be fixed by RB-17; if not, fix it here.

## Migration plan

1. Hand-write `0018_view_tabs.sql`; snapshot (next free file name).
2. Migration test over seeded 0000..0017 data (criterion 10).
3. `npm run deploy` (bookmark, additive migration, build, deploy). Rollback: `wrangler rollback`; older code ignores
   the column.

## Tracker impact

New `docs/TASKS.md` item "RB-18 Grouped table, swimlanes and view tabs (Claude)". Moves "swimlanes" out of RB-08's
out-of-scope list. `docs/ACCEPTANCE.md` rows: grouped counts equal flat totals (Automated), viewport spec for grouped
list, lanes and tabs (Pass).

## Owner decisions (proposed defaults)

| # | Decision | Proposed default |
|---|---|---|
| O1 | Group keys | status, priority, assignee, type, milestone, cycle, parent, label (list); plus project (issues); lanes without label |
| O2 | Caps | 50 groups, 20 sub-groups, 25 rows per group, 500 rows; 20 lanes, 50 cards per lane-column |
| O3 | Tasks with several labels when grouped by label | **Shown in each label group**, with a note |
| O4 | Drag between swimlanes | **Not allowed** (status moves only); change the lane field on the task |
| O5 | Pinned tabs | **Personal, 8 per project and 8 on Issues** |
| O6 | Updating a saved view | **Allowed for its owner** ("Update view") |
| O7 | Default columns | today's columns; the chooser adds the rest |
