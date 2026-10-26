# RB-15 Tracker roadmap (umbrella for RB-16 to RB-19 and later tracker work)

Status: **proposal, awaiting owner answers** to section 6. Author: CTO strategist, 2026-10-26.
Owner request (2026-10-26): grow Ruby's tracker towards a feature list the owner supplied (a full open-source issue
tracker). Only behaviour is mirrored. That project's code, schema, interface text, documentation, assets and names
are not used, quoted or linked anywhere in Ruby: its licence (AGPL-3.0) is incompatible with Ruby's MIT licence for
copied material. Every design below is Ruby's own, built on Ruby's existing modules.

## 1. What Ruby has and what is in flight

| Id | State | Tracker-relevant content |
|---|---|---|
| RB-00 | live | Invite-only accounts, two roles, Cloudflare Access in front, Markdown renderer, shell |
| RB-01 | live | Projects with keys, numbered tasks, six fixed statuses, priority, assignee, due date, list and board, My tasks |
| RB-02 | live | Page trees (team and per project), revisions, restore, FTS search over pages and tasks |
| RB-03 | live | Comments (flat), @mentions, in-app notification inbox |
| RB-04 | live | Attachments on tasks and pages (R2) |
| RB-08 | live | Project labels, checklists, milestones, column rename/hide, WIP limits, personal saved views, bulk edit |
| RB-10 | live | Design kit (Card, Table, Tabs, Dialog, DropdownMenu, Toaster, Checkbox, Switch) |
| RB-11 | live | Release notes and reload; version guard in deploy |
| RB-09 | in build, migration `0011`, v0.4.0 | `/calendar` (tasks, milestones, events, time off), reminders, the `ruby-jobs` cron Worker, e-mail reminders behind a flag |
| RB-12 | in build, migration `0012`, v0.6.0 | Task types (Task, Bug, Feature request, Improvement), cross-project `/issues` with filters, saved views, bulk edit, Report an issue, team labels |

RB-05, RB-06 and RB-07 are HR features and do not affect this roadmap.

## 2. Gap analysis

Have = built or in build and covers the behaviour. Partial = part of it exists. Missing = nothing yet.
"Ruby differs" marks a deliberate boundary from `CLAUDE.md` (one team, every active user sees everything, Cloudflare
Workers + D1 + R2, English only, invite-only, no AI).

| # | Capability area | Ruby today or in flight | Status | Plan |
|---|---|---|---|---|
| 1 | Issue types | RB-12: four fixed types for every project | Partial | Phase B: per-project enable/disable of the four types. Custom type names: later |
| 2 | Workflow states per project | RB-08: rename, hide and WIP-limit the six fixed statuses | Partial | Keep the six stored statuses (Ruby differs: one shared "closed" meaning for search, My tasks, calendar, insights). Fully custom states: later, own PRD (rebuild of `tasks`) |
| 3 | Labels | RB-08 project labels, RB-12 team labels | Have | — |
| 4 | Custom fields | none | Missing | Phase B, RB-23 |
| 5 | Cycles (time-boxed iterations, carry-over of unfinished work) | RB-08 milestones are dated targets, not time boxes | Missing | **Phase A, RB-17** |
| 6 | Kanban board | RB-01 board, RB-08 WIP and column settings | Have | Swimlanes come with RB-18 |
| 7 | Table view (column choice) | RB-01 list is a fixed-column table | Partial | **Phase A, RB-18** |
| 8 | Timeline view | none (tasks have no start date) | Missing | Phase B, RB-25 (adds `starts_on`) |
| 9 | Calendar view | RB-09 `/calendar` with `project=KEY` filter | Partial | Phase B: a Calendar tab on the project page that opens RB-09 filtered; no second calendar |
| 10 | Saved views as tabs | RB-08 / RB-12 personal saved views in a picker | Partial | **Phase A, RB-18** (pinned tabs). Team-shared views: Phase B |
| 11 | Two-level grouping, swimlanes | none | Missing | **Phase A, RB-18** |
| 12 | Subtasks | RB-08 checklists (steps, no own status) | Partial | **Phase A, RB-16** (sub-issues) |
| 13 | Issue relations (blocks, relates, duplicates) | none | Missing | **Phase A, RB-16** |
| 14 | Project dashboards (throughput, burnup with projection, breakdown) | RB-08 milestone progress bar only | Missing | **Phase A, RB-19** (fixed set of charts). Configurable widgets and a workspace dashboard: Phase B |
| 15 | Quick actions (a saved set of changes applied to an issue) | RB-08/RB-12 bulk edit | Partial | Phase B, RB-22 |
| 16 | Auto-assignment when an issue enters a state | none | Missing | Phase B, RB-22 (rule evaluated inside the write batch; no job) |
| 17 | Auto-archive of finished issues | none | Missing | Phase B, RB-24, as a read-time rule (closed more than N days ago is hidden from the board); no background job |
| 18 | Public read-only share links | none | Missing | **Ruby differs.** Out of scope by default: Access + invite-only, data is internal (decision 3) |
| 19 | Initiatives (group related work) | RB-08 milestones inside a project; RB-12 team labels across projects | Partial | Later; revisit after cycles and insights are used |
| 20 | Notes board / whiteboard canvas | none | Missing | Out of scope: a canvas editor is a large client app with its own sync model; the KB covers written notes |
| 21 | Docs: tree, Markdown, revisions, mentions, embedded files, comments | RB-02, RB-03, RB-04 | Have | — |
| 22 | Docs: links from pages to issues | Markdown links only; no back-links on the task | Partial | Phase B, RB-26 (back-links computed on save, like mentions) |
| 23 | Docs: locked pages | none | Missing | Phase B, RB-26 (author and admins may edit; everyone still reads) |
| 24 | Docs: private pages | none | Missing | **Ruby differs.** Out of scope: conflicts with "every active user sees every page" |
| 25 | Docs: favorites | none | Missing | Phase B, RB-26 (personal, like saved views) |
| 26 | Comment threads with replies | RB-03 flat comments | Partial | Phase B, RB-27 (one reply level) |
| 27 | Notification inbox | RB-03 | Have | — |
| 28 | Notifications by e-mail or chat apps, per-member preferences | RB-09 e-mail for reminders only (behind a flag) | Partial | Later; needs a verified sender domain and a digest design |
| 29 | REST API with OpenAPI and API keys | none (form actions and a few internal JSON routes) | Missing | Later (decision 4) |
| 30 | Outgoing webhooks (signed, retried, delivery log) | none | Missing | Later, after the API (decision 5) |
| 31 | MCP server for external assistants | none | Missing | Later, on top of the API (decision 6) |
| 32 | Pull-request linking from code forges ("Fixes KEY-42") | none | Missing | Later, GitHub only (decision 7) |
| 33 | Passkeys | none | Missing | Phase B candidate (decision 8) |
| 34 | Google sign-in | Cloudflare Access can use Google as its identity provider | Partial | **Ruby differs.** No in-app OAuth; use Access (decision 8) |
| 35 | AI agents as teammates | none | Missing | **Ruby differs.** `CLAUDE.md` says no AI (decision 2) |
| 36 | Interface languages | English only | Missing | **Ruby differs.** Out of scope (`CLAUDE.md`: no i18n layer) |
| 37 | Roles and access control | admin, member, HR capability | Partial | **Ruby differs.** No per-project roles (every active user sees everything) |
| 38 | Several workspaces, SSO/SCIM per workspace, billing editions | one organisation | Missing | **Ruby differs.** Out of scope (one team, no multi-tenancy, no billing) |

Counts over the 38 areas: **Have 4**, **Partial 13**, **Missing 21**. Of the Missing and Partial ones, 8 are deliberate
boundaries (18, 20, 24, 34, 35, 36, 37, 38).

Ruby already has things the list does not stress: FTS search over pages and tasks, attachments with safe downloads,
WIP limits, checklists, HR modules, release notes.

## 3. Product stance

- Build what makes daily planning faster for one team on Cloudflare (D1 + R2 + one app Worker plus RB-09's
  `ruby-jobs`). Prefer read-time rules and work inside the write batch over new background jobs.
- Never fork RB-01, RB-08 or RB-12 modules. Extend `tasks/repo.ts`, `tasks/validation.ts`, `pm/*` and `issues/*`
  (RB-12) with new filters, columns and guarded statements.
- Every new filter goes through the one parser per scope (`parseFilters`, RB-12 `parseIssueFilters`) and the one
  saved-view canonicaliser (`canonicalizeQuery`), so saved views keep working.
- No new third-party runtime dependency for charts or grouping: inline SVG from the server, SQL aggregates.
- Anything that opens Ruby to clients outside a browser session (share links, API, webhooks, MCP, forge
  callbacks) is a separate owner decision because it pierces the Access + invite-only model.

## 4. Phases

### Phase A (next; PRDs written now)

| Order | Id | Feature | Migration | Version | Risk | PRD |
|---|---|---|---|---|---|---|
| 1 | RB-16 | Sub-issues and issue relations | `0016_subissues_relations.sql` | 0.8.0 | Large | `docs/features/rb-16-subissues-relations/PRD.md` |
| 2 | RB-17 | Cycles | `0017_cycles.sql` | 0.9.0 | Large | `docs/features/rb-17-cycles/PRD.md` |
| 3 | RB-18 | Grouped table, swimlanes and view tabs | `0018_view_tabs.sql` | 0.10.0 | Medium | `docs/features/rb-18-grouped-views/PRD.md` |
| 4 | RB-19 | Project insights (throughput, burnup, breakdown) | `0019_insights_indexes.sql` | 0.11.0 | Medium | `docs/features/rb-19-project-insights/PRD.md` |

Why this order: sub-issues and relations change the task model and every later feature reads them (grouping by
parent, "blocked" filters, insights scope). Cycles come next because grouping and insights both offer a cycle
dimension. Grouping is pure read and UI. Insights is read-only and benefits from all three.

Shared rules for Phase A:
- Migration numbers start at `0016` (`0011` RB-09, `0012` RB-12 and `0013` to `0015` RB-21 are taken). If a PRD ships out of order, it keeps
  its number; wrangler applies by file name and each migration is additive or a leaf change.
- Drizzle snapshot files: RB-06 already used `0011_snapshot.json` (drizzle-kit chains by file name). Each engineer
  takes the next free snapshot file name and records the mapping in the PRD summary; the journal tag is the
  migration's file name.
- Each feature ships alone with its release note (`src/lib/content/releases/<version>.md`) and the
  `package.json` / `APP_VERSION` bump (RB-11 deploy guard). Versions 0.8.0 to 0.11.0 in the order above; if an
  earlier one slips, renumber the later ones at ship time so versions stay ascending.
- All four depend on RB-12 being merged (they extend `/issues`, `issues/query.ts`, the rebuilt `saved_views` and
  `issuesBulkUpdate`). If RB-12 is still open, the engineer waits; do not build against the pre-RB-12 schema.

### Phase B (PRD when Phase A is live)

- RB-23 Custom fields: per-project fields of type text, number, date, single select, multi select, user; 20 per
  project; filter, sort, group and bulk; values in a typed side table, not JSON on `tasks`.
- RB-22 Quick actions and auto-assignment: per-project named action sets ("Send to review": status In review,
  assignee lead); rule "when status becomes X, assign Y" evaluated inside the same write batch.
- RB-24 Auto-archive as a display rule: closed tasks whose `completed_at` is older than N days (per project, default
  14) are hidden from the board and default list; still searchable and filterable.
- RB-25 Timeline: `tasks.starts_on`, a server-rendered bar chart per project, dependencies drawn from RB-16 "blocks".
- RB-26 Docs extras: favorites (personal), locked pages, page to issue back-links.
- RB-27 Comment replies (one level).
- Team-shared saved views; workspace-level insights across projects; per-project type enablement; project Calendar
  tab linking RB-09; passkeys if decision 8 says so.

### Later (needs an owner decision that changes `CLAUDE.md`)

REST API with OpenAPI and personal API tokens; outgoing webhooks; MCP server; GitHub pull-request linking; e-mail
and chat notifications beyond reminders; initiatives; fully custom workflow states; status history log for exact
burnup (RB-19 derives history from timestamps).

### Out of scope (deliberate)

AI agents (unless decision 2 changes), interface languages other than English, whiteboard canvas, private pages,
public share links (unless decision 3 changes), in-app Google OAuth, several workspaces, SSO/SCIM per workspace,
per-project roles, billing editions, self-hosting outside Cloudflare.

## 5. Conflicts with RB-12 to watch (each Phase A PRD repeats the ones it touches)

- `/issues` filters: RB-16 adds `parent`, `blocked`; RB-17 adds `cycle`; RB-18 adds `group`, `sub`, `cols`. Each must
  extend `parseIssueFilters` and `canonicalizeQuery('issues', …)` and re-prove the worst-case stored query length.
  RB-12 caps issue views at 1 000 characters; RB-18 raises the application cap (no DB constraint exists) and proves
  the new worst case.
- `saved_views` is rebuilt by `0012`. Phase A never rebuilds it again: RB-18 adds one nullable column with
  `ALTER TABLE ADD COLUMN`.
- `issuesBulkUpdate` (RB-12 D6) is cross-project; parent and cycle are project-scoped and stay out of it, like
  milestones and project labels.
- The `tasks` table gains `parent_id` (RB-16) and `cycle_id` (RB-17) by `ADD COLUMN`, never a rebuild, so the
  `tasks_fts_*` triggers stay untouched.

## 6. Owner decisions (roadmap level; each PRD has its own feature-level list)

| # | Decision | Proposed default |
|---|---|---|
| 1 | Phase A scope and order | **Yes**: RB-16 sub-issues and relations, RB-17 cycles, RB-18 grouped views and tabs, RB-19 insights, in that order |
| 2 | AI agents as teammates | **No** (keeps `CLAUDE.md` "no AI"). If the owner says yes later: own PRD, Anthropic Claude through Cloudflare AI Gateway (model chosen at build from current docs, key as a Worker secret, never in D1), an agent is a non-login user row with `kind = agent`, runs triggered by @mention or assignment and executed by `ruby-jobs`, monthly spend cap, every agent write audited; amends `CLAUDE.md` |
| 3 | Public read-only share links | **No.** Ruby data is internal and Access fronts the host. If yes later: admin-created, per issue or per view, 256-bit token stored hashed, read-only, expires in at most 30 days, revocable, Access bypass for one path prefix (same pattern as the RB-09 calendar feed) |
| 4 | REST API with OpenAPI and API tokens | **Later.** When built: personal tokens (hashed, read or read-write scope, 90-day expiry, max 5 per user), on a deployed host also a Cloudflare Access service token, OpenAPI document generated from the same validators |
| 5 | Outgoing webhooks | **Later, after the API.** Signed (HMAC-SHA256), retried by `ruby-jobs` with a delivery log; admin-only setup |
| 6 | MCP server | **Later, on top of the API tokens.** Read first, write behind its own scope |
| 7 | Pull-request linking from code forges | **Later, GitHub only.** Needs an inbound webhook path that bypasses Access and a per-repository secret |
| 8 | Sign-in options | **Google: no in-app OAuth**, configure Google as the Cloudflare Access identity provider. **Passkeys: Phase B candidate**, as a second factor or password replacement for app accounts |
| 9 | Custom fields and per-project workflow | **Custom fields in Phase B (RB-23). Custom workflow states: later**; the six stored statuses stay |
| 10 | Auto-archive | **Phase B (RB-24) as a display rule**, 14 days, no background job |
