# RB-19 Project insights (throughput, burnup, breakdown) — PRD

Request: owner, 2026-10-26, tracker roadmap (`docs/features/rb-15-tracker-roadmap.md`, Phase A item 4). RB-19 is
proposed here.

Risk tier: **Medium**. Reasons: read-only page, no writes, an index-only migration on `tasks`, aggregate queries that
must stay bounded, server-rendered charts. Pipeline: engineer + QA (red team optional: parameter abuse and query
cost only).

Depends on: RB-01, RB-08 (milestones), **RB-12** (types, team labels), RB-16 (blocked count) and RB-17 (cycle scope and
cycle report); a missing dependency's widget is left out and added by that feature. Migration
**`0019_insights_indexes.sql`**. Version **0.11.0**.

## Goal

A project lead today can see a milestone's progress bar and nothing else: not how many tasks the team finishes per
week, whether a milestone or cycle will land on time, or where open work piles up. This increment adds one
**Insights** tab per project with a fixed set of charts and numbers: **throughput**, **burnup with a projected finish
date**, **breakdown** of open work, a short **pulse**, and a **cycle report**. Everything is computed from task data
already in D1; nothing new is written.

## Current behaviour this builds on (cite before changing)

- `tasks` timestamps: `created_at`, `updated_at`, `completed_at` (set on entering `done`/`canceled`, cleared on
  reopening by `completedAtFor`, `tasks/repo.ts:107`), `deleted_at` (`schema.ts:161-199`).
- Indexes on `tasks` today: `tasks_project_status_idx (project_id, status, position)`, `tasks_assignee_idx`,
  `tasks_milestone_idx`; RB-12 adds live-only global `created_at`/`updated_at` indexes, not per project.
- Milestone progress rule (done over non-canceled): `pm/milestones.ts:235` `progressFrom`, :246
  `milestoneProgress`.
- RB-17: `cycles` with `starts_on`, `ends_on`, stored `scope_count`/`done_count`/`carried_count` at completion,
  `tasks.cycle_id`, `cycle_carryovers`.
- RB-16: blocked derivation (`pm/relations.ts` `blockedCondition`).
- Team date helpers: `tasks/today.ts`, RB-09 `src/lib/shared/calendar.ts` `zonedToUtc` (DST-safe team-zone →
  UTC conversion). `TEAM_TIME_ZONE` var.
- There is **no status-history table**: Ruby keeps only the current state of each task.

## Design decisions (the CTO calls; owner can override under Owner decisions)

### D1. Derived from current data, said plainly

All series are computed from the current rows: a task counts in a scope from its `created_at`; it counts as done
from its `completed_at` while its status is `done`. Consequences, shown in a footnote on the page ("Built from
current task data"): a reopened task loses its earlier completion; a task moved into a milestone or cycle counts as
if it had been there since it was created; deleted tasks and canceled tasks are left out everywhere. An exact
history needs an append-only status log written by every task write path; that is a later, separate PRD (O2).

### D2. Time buckets in the team zone, computed outside SQL

Bucket bounds (days or Monday-start weeks) are computed in TypeScript with `zonedToUtc` for `TEAM_TIME_ZONE` and
passed to SQL as **one JSON array** (`json_each`), so no `+7 hours` offsets appear in SQL and the 100-parameter limit
is never close. Each series is one statement of the form `SELECT b.key, (SELECT count(*) FROM tasks t WHERE
<scope> AND t.completed_at >= b.from AND t.completed_at < b.to …) FROM json_each(:bounds) b`, served by the new
per-project indexes (index range counts, at most 182 bounds).

### D3. Scope selector

`scope=project` (default; window `range=30|90|180` days, default 90), `scope=milestone&milestone=<id>` (from the
milestone's first task's `created_at` or 180 days before today, whichever is later, to its due date or today),
`scope=cycle&cycle=<number>` (the cycle's `starts_on` to `ends_on`). Invalid values fall back to the default with a
"Some options were ignored" note. All in the URL; works without JavaScript.

### D4. Widgets (fixed set, not configurable in this pass)

| Widget | Definition |
|---|---|
| **Throughput** | Tasks reaching `done` per week, last `weeks=4|12|26` weeks (default 12), with tasks created per week as a second series (inflow vs outflow). Canceled excluded. Optional filter `type=` (RB-12) and `assignee=` |
| **Burnup** | Per day in the scope window: *scope* = live non-canceled tasks in scope with `created_at` before day end; *done* = those with status `done` and `completed_at` before day end. Plus the projection (D5) |
| **Breakdown** | Open tasks in scope (status not `done`/`canceled`) by status, priority, assignee (top 10 + "Others"), type, label (top 10 project + team labels; a task counts once per label) |
| **Pulse** | Numbers for the last 7 days and the 7 before: created, completed, open overdue (due before team today), open blocked (RB-16), open unassigned; each with the change |
| **Cycle report** | Last 8 completed cycles from RB-17's stored counts: scope, done, carried over, done / scope % |

### D5. Projected finish

Pace = tasks done in the last 28 days of the window (or since the window start if shorter) divided by those days.
Remaining = scope − done at today. Projected date = today + ceil(remaining / pace) days, shown as a team date with the
pace in words ("At the recent pace of 6 a week, the remaining 14 tasks finish around 12 Dec"). Rules: fewer than 14
days of window or pace 0 → "Not enough recent completions to project"; remaining 0 → "All done"; for a milestone with
a due date or a cycle, also "on track" or "after the due date by N days". The projection is drawn as a dotted line from
today's done value to the scope line. It is an estimate and labelled as one.

### D6. Charts are server-rendered SVG

One small Svelte component per chart type (`LineChart`, `BarChart`, `BarList`) rendering inline SVG with a `viewBox`,
`width: 100%`, text labels and axis ticks thinned for narrow widths; no chart library, no client JS needed. Series are
told apart by line style and direct labels, not colour alone; colours come from CSS tokens in `src/app.css` (light
and dark). Every chart has a `<details>` "Show data" table with the same numbers (screen readers, no-JS, copying). All
labels (assignee names, label names) are plain text in SVG `<text>` (escaped by Svelte; never `{@html}`).

## Scope

### Migration `0019_insights_indexes.sql`

```
CREATE INDEX tasks_project_created_idx ON tasks(project_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX tasks_project_completed_idx ON tasks(project_id, completed_at)
  WHERE deleted_at IS NULL AND completed_at IS NOT NULL;
```

Index-only; no table or trigger change. `schema.ts` index declarations, snapshot (next free file name; journal tag
`0019_insights_indexes`). Two more indexes slow task writes slightly; accepted (RB-12 made the same trade).

### Routes

| Route | Purpose |
|---|---|
| `projects/[key]/insights/+page.server.ts/.svelte` | Load only (no actions): parse scope, compute widgets in one batch |
| `projects/[key]` layout | New tab "Insights" after Cycles |
| `projects/[key]/milestones/[id]` | Link "Burnup for this milestone" → insights `scope=milestone` |
| `projects/[key]/cycles/[number]` (RB-17) | Link "Burnup for this cycle" → insights `scope=cycle` |

### Server modules

- New `src/lib/server/insights/query.ts`: `parseInsightsParams(params, project)`, `throughput(db, scope, weeks,
  filters)`, `burnup(db, scope, window)`, `breakdown(db, scope)`, `pulse(db, scope, today)`, `cycleReport(db,
  projectId)`; all statements returned as batch items so the loader sends one batch.
- New pure `src/lib/shared/insights.ts`: `dayBounds(fromOn, toOn, zone)`, `weekBounds(weeks, today, zone)`,
  `projectFinish(series, today)`, `INSIGHT_LIMITS`.
- UI: `src/lib/ui/insights/LineChart.svelte`, `BarChart.svelte`, `BarList.svelte`, `PulseTiles.svelte`,
  `ScopePicker.svelte`, `DataTable.svelte`; icon `chart` in `ICONS`.
- Reuse, never copy: the milestone progress rule (done over non-canceled), RB-16 `blockedCondition`, RB-17
  `getCycleByNumber`, RB-12 `TASK_TYPES` and team-label joins, `teamToday`, `zonedToUtc`.

## Limits (`INSIGHT_LIMITS`)

| Limit | Value |
|---|---|
| Burnup window | ≤ 181 days (cycle ≤ 56, project 30/90/180, milestone ≤ 180 before today) |
| Throughput | 4, 12 or 26 weeks |
| Bounds per statement | ≤ 182 (one JSON parameter) |
| Breakdown groups | top 10 + "Others" for assignee and label; all for status, priority, type |
| Cycle report | last 8 completed cycles |
| Requests | 60 per user per minute (throttle scope `insights`, `overUserMinuteLimit`), answers 429 "Slow down a little" |

## Authorization per action

| Action | Rule |
|---|---|
| Insights load | `requireUser`; every active user (one team sees everything); archived projects viewable; deleted project 404 |
| Milestone or cycle in the scope | must belong to this project and be live, else ignored with a note (same answer for hidden and missing) |

No actions, no writes.

## Concurrency

None written. All widget statements run in one `db.batch`, so the numbers on one page come from one consistent
snapshot. Two loads at the same time cannot affect each other.

## States

- Loading skeleton per widget while navigating; each widget has its own empty state ("No tasks finished in the last
  12 weeks", "No open tasks", "No completed cycles yet") and the page as a whole: "This project has no tasks yet".
- Error banner with Retry (load failure); 429 banner.
- Projection states: estimate, "Not enough recent completions", "All done", "on track", "after the due date by N
  days".
- Footnote D1 always visible; "Some options were ignored" note for bad parameters.

## Mobile layout (402×874, 440×956, 360 px)

- One column of RB-10 `Card`s in this order: Pulse, Burnup, Throughput, Breakdown, Cycle report.
- Charts scale to the card width (SVG `viewBox`); at 360 px x-axis labels show every 4th week or every 7th day,
  y-axis 3-4 ticks; minimum chart height 180 px; no horizontal scroll at page level or inside charts.
- Pulse tiles in a 2×N grid below 768 px; numbers ≥ 20 px; change shown as text ("+3"), not colour only.
- Scope picker: selects in a row that wraps; each ≥ 44 px tall, text ≥ 16 px; "Apply" submit button for no-JS.
- "Show data" summaries ≥ 44 px; tables inside scroll their own container if wide.
- Safe areas only via `--sai-*`. Viewport spec extended for the insights page at the three widths, including a
  milestone scope and a 26-week throughput.

## Performance budget

| Page | Round trips after auth | Statements |
|---|---|---|
| Insights | 1 | ≤ 10 (throughput 1, burnup 1, breakdown ≤ 5 as one grouped statement each, pulse 1, cycle report 1, scope object 1) |

Each statement is bounded: series by ≤ 182 bounds × index range counts; breakdowns by `GROUP BY` over the project's
open tasks (`tasks_project_status_idx`). Test with 20 000 tasks in one project: the page's statement count is
constant and the load finishes within a test-time bound; `EXPLAIN QUERY PLAN` shows the new indexes for the series.

## Acceptance criteria

Tags: [A] Automated, [P] Pass, [M] manual.

1. [A] Signed-out and deactivated requests are refused; a deleted project gives 404; an archived project renders.
2. [A] A milestone id or cycle number of another project, deleted, or malformed is ignored with the note; the answer
   is the same for hidden and missing.
3. [A] Throughput counts exactly the tasks whose status is `done` and `completed_at` falls in each team-zone week;
   canceled, deleted and reopened tasks are not counted; week edges at Monday 00:00 team time are exact (test tasks at
   23:59:59.999 Sunday and 00:00 Monday in the team zone).
4. [A] Burnup scope and done series match a hand-computed fixture for project, milestone and cycle scopes, including
   tasks created and completed on the window's first and last days.
5. [A] Projection: fixture with 6 done per week and 14 remaining gives the stated date; pace 0 and a window under 14
   days give "Not enough recent completions"; remaining 0 gives "All done"; milestone and cycle due comparisons are
   correct.
6. [A] Breakdown counts equal the project list's counts for the same open-task filters; top-10 + Others sums to the
   total (labels: per-label counts, stated).
7. [A] Pulse numbers equal hand-computed values; blocked uses RB-16's rule; overdue uses team today.
8. [A] Cycle report shows RB-17's stored counts for the last 8 completed cycles and nothing for other projects.
9. [A] All user text (names, labels, milestone names) appears as escaped text in SVG and tables; a label named
   `<script>` renders literally.
10. [A] Statement count ≤ 10 and constant between 10 and 20 000 tasks; bounds always one JSON parameter; plans use
    `tasks_project_created_idx` and `tasks_project_completed_idx`.
11. [A] After `0019`, the two indexes exist, `integrity_check` ok, task counts unchanged, FTS unchanged.
12. [A] The 61st load within a minute answers 429 and runs no widget query.
13. [P] Without JavaScript the page and scope picker work; "Show data" opens.
14. [P] Viewport spec at 360, 402, 440 px: no horizontal scroll; tap targets ≥ 44 px; charts readable.
15. [M] Dark mode and light mode chart contrast AA for lines, bars and text; series distinguishable in greyscale.
16. [A] Release note `0.11.0.md`; versions bumped; all earlier tests pass; `npm run gates` passes; checklist probes
    listed.

## Test plan

Unit: `dayBounds`/`weekBounds` (team zone, a DST zone for safety, year edges), `projectFinish` table, parameter
parser.
Integration: fixture project with dated tasks (created, completed, reopened, canceled, deleted, moved between
milestones), milestone and cycle scopes, 20 000-task performance seed, query counts and plans, throttle.
Browser: viewport spec; no-JS scope change; dark mode screenshot.

## Out of scope

Configurable widgets and layouts; a workspace dashboard across projects (Phase B); exact history (status log, O2);
cumulative flow, cycle time and lead time (need history); estimates or story points; exports (CSV, image); e-mail or
scheduled reports; per-person performance views (deliberately not built: the page shows team flow, not individual
scoring, beyond the open-work breakdown by assignee); caching layers (no KV).

## Prerequisites

None. `TEAM_TIME_ZONE` already set; RB-09's `zonedToUtc` (if RB-09 is not merged, the engineer adds the same pure
helper in `src/lib/shared/` and RB-09 reuses it).

## Architecture notes

Read-only module under `src/lib/server/insights/`; no change to task write paths. Conflicts with RB-12: none on
`/issues` (a cross-project insights page is Phase B); reads RB-12 types and team labels. With RB-16/RB-17: reads
their tables only.

## Migration plan

1. Hand-write `0019_insights_indexes.sql`; snapshot (next free file name).
2. Migration test over seeded data (criterion 11).
3. `npm run deploy` (bookmark, index creation, build, deploy). Index creation on the production `tasks` table is a
   short write; rollback: `wrangler rollback`; the indexes can stay or be dropped by a later migration.

## Tracker impact

New `docs/TASKS.md` item "RB-19 Project insights (Claude)". `docs/ACCEPTANCE.md` rows: insights numbers match
fixtures (Automated), viewport spec for insights (Pass).

## Owner decisions (proposed defaults)

| # | Decision | Proposed default |
|---|---|---|
| O1 | Widget set | Throughput, burnup with projection, breakdown, pulse, cycle report; fixed, not configurable |
| O2 | History source | **Derived from current data** with a footnote; an exact status log is a later PRD |
| O3 | Who sees insights | **Every active user** |
| O4 | Projection basis | **Last 28 days** of completions; at least 14 days of data |
| O5 | Week start | **Monday** in `TEAM_TIME_ZONE` |
| O6 | Canceled tasks | **Excluded** from scope and throughput (milestone rule) |
| O7 | Per-person numbers | Open work by assignee only; **no per-person throughput ranking** |
