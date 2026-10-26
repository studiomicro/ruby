# RB-09 Calendar and reminders — PRD

Risk tier: **Large** (first background job and a second Worker, a change to the production deploy path, a rebuild of the live `notifications` table, a token-authenticated unauthenticated-by-session feed, edits to the hot RB-01 task detail route; engineer + QA + red team).

Request: owner, 2026-10-26, "add calendar feature and add reminder". RB-09 is proposed here (no ID was given).

Depends on: RB-01 (tasks, `due_on`), RB-03 (`notifications`, `/notifications`, unread badge), RB-08 (milestones with `due_on`; in review). Soft dependency on RB-06 (time off, holidays; in build). No dependency on RB-05: employee data (birthdays, anniversaries) is deliberately **not** shown.

Migration: `0011_calendar_reminders.sql` (RB-05 0002, RB-06 0003, RB-07 0004 reserved, RB-08 0010; confirm 0011 is still free at merge).

## Goal

Dates are scattered today: task due dates sit in lists, milestone dates in project pages, leave in RB-06. Nobody can see "what is happening this week" in one place, cannot put a meeting or a deadline that is not a task on a shared timeline, and nothing taps a person on the shoulder before something is due. This increment adds one `/calendar` that aggregates those dates with first-class team events, and a reminder system (tasks, events, personal) that delivers into the existing in-app notifications, driven by a small scheduled jobs Worker.

## Current behaviour this builds on

- `tasks.due_on` is a `YYYY-MM-DD` text with no time zone (`src/lib/server/db/schema.ts`, `tasks` table); "today" is the team date in `TEAM_TIME_ZONE` via `src/lib/server/tasks/today.ts:5` and `dates.ts`. `TEAM_TIME_ZONE` = `Asia/Jakarta` is in `wrangler.jsonc` vars.
- `notifications` (schema.ts, "In-app notifications. Never sent to oneself"): `actor_id` NOT NULL, `kind` CHECK `('mention','assigned','comment')` (`NOTIFICATION_KINDS` in `src/lib/shared/enums.ts`), `target_kind` CHECK `('task','page')`, `comment_id` FK, index `notifications_user_idx (user_id, read_at, created_at)`. Original DDL: `migrations/0000_init.sql:63-80`. Reads: `src/lib/server/notifications/repo.ts` (`listNotifications`, unread count capped by `UNREAD_COUNT_CAP`, `describeNotifications` with a `VERBS` map keyed by `NotificationKind`). Targets resolve through `src/lib/server/targets/resolve.ts`.
- One app Worker, no jobs Worker, no cron, no e-mail (`CLAUDE.md`: "No jobs or inbound Workers", "no background jobs, no e-mail sending beyond what an owner decision adds later"). `scripts/deploy.ts › buildSteps` runs bookmark, `d1 migrations apply`, `vite build`, `wrangler deploy` for the one app.
- Markdown only via `src/lib/shared/markdown.ts`.

This PRD therefore **requires an owner decision (O1) that amends two `CLAUDE.md` lines** (locked architecture and product boundaries) before the build.

## Owner decisions (proposed defaults)

| # | Decision | Proposed default |
|---|---|---|
| O1 | Allow a second Worker `ruby-jobs` with a Cron Trigger (amends `CLAUDE.md`: "one app Worker", "no background jobs") | **Yes.** Without it reminders cannot fire on time; the app Worker cannot host a `scheduled` handler through the SvelteKit adapter |
| O2 | Who sees events | **Team events** (default) are visible to every active user; **Private** events only to creator and attendees. Admin does not see others' private events |
| O3 | Who edits or deletes an event | Creator or admin. Attendees cannot edit. (Project lead is not added: keeps one rule) |
| O4 | iCal feed | **OFF.** Enabled only by setting var `CALENDAR_FEED_ENABLED = "1"` after the owner reads the leak trade-off below |
| O5 | E-mail reminders | **OFF.** Needs a verified Cloudflare Email Sending sender domain; in-app only until then. Schema is ready, code path built behind var `REMINDER_EMAIL_FROM` (empty = off) |
| O6 | Time of day a task-due-date reminder is anchored to | **09:00 `TEAM_TIME_ZONE`** on the due date, minus the chosen offset |
| O7 | Late tolerance after an outage | A due reminder is still sent if at most **24 h** late; older ones close as `missed` (no notification) |
| O8 | Time zone shown | Events are entered and shown in `TEAM_TIME_ZONE` with the label "WIB" (derived from the zone), not the browser's zone |
| O9 | RB-06 time off on the calendar | Show **who is out** (names, approved requests, no leave type, no reason, no pending), same privacy as the RB-06 calendar, to every active user; public holidays shown. Built only if RB-06's tables exist at build; else follow-up item |
| O10 | Recurrence | Daily, weekly (same weekday), monthly (same day of month, clamped to the month's last day); interval 1-30; must end (until date or count, max 2 years and 500 occurrences). No RRULE |
| O11 | Reminder caps | 10 reminders per user per target; 200 pending per user |
| O12 | Retention | Closed reminders purged after 90 days; events soft-deleted, not purged |
| O13 | Web Push | **Out of scope** (needs VAPID keys, subscription storage, a service worker; not trivial) |
| O14 | Archived-project tasks on the calendar | Hidden. Completed (done/canceled) tasks hidden unless "Show completed" is on |


## Owner answers (2026-10-26)

- O1: **yes** — add the `ruby-jobs` Worker with a once-a-minute Cron Trigger (CLAUDE.md amended in the RB-09 PR).
- O2: **team + private** (default). O4: iCal feed **off** (default).
- O5: **in-app + e-mail** — build e-mail delivery behind `REMINDER_EMAIL_FROM` (Cloudflare Email Sending); while it is
  empty or the sender domain is unverified, e-mail is skipped and in-app still delivers. Proposed sender
  `ruby@<app host>` (owner to confirm and verify the domain).
- Every other decision: the proposed default.

## Scope

### 1. Calendar at `/calendar`

Routes (all inside `(app)`, session-guarded):

| Route | Purpose |
|---|---|
| `calendar/+page.*` | Month, week, agenda. Load `calendar(range)` |
| `calendar/events/new/+page.*` | Create form (action `create`) |
| `calendar/events/[id]/+page.*` | Event detail: rendered description, attendees, location, reminders panel, Delete, Edit link (actions `remove`, `removeOccurrence`, `reminderAdd`, `reminderRemove`) |
| `calendar/events/[id]/edit/+page.*` | Edit (action `update`) |
| `calendar/feed/[file]/+server.ts` | Read-only `.ics` (only when O4 is on); **outside `(app)`**, token auth |
| `reminders/+page.*` | My reminders: pending, history, create personal (actions `create`, `remove`) |
| `account` (edit) | Section "Calendar feed" (enable / rotate / revoke) when O4 on; "E-mail reminders" toggle when O5 on |
| `projects/[key]/tasks/[number]` (edit) | Sidebar "Reminders" panel: add (preset or absolute), remove; actions `reminderAdd`, `reminderRemove` |
| Nav | Add "Calendar" to sidebar and bottom tab bar group (bottom bar overflow rule stays RB-00's); "Reminders" reachable from Calendar page header and `/notifications` |

**Views.** `view=month|week|agenda`, `date=YYYY-MM-DD` (anchor, team date). Absent `view`: the server renders both the month (or week) block and the agenda block, and CSS shows the agenda below 768 px and the month at 768 px and up (works without JS; both blocks are bounded by the caps below). Explicit `view` wins at every width. Prev / Next / Today are links.

- **Month**: 6x7 grid of day cells. At >= 768 px a cell lists up to 3 chips then "+N more" linking to `view=agenda&date=<day>`. At phone widths a cell shows up to 3 coloured dots plus a count and the whole cell is a link (min 44 x 44 px) to that day's agenda. Colour is never the only signal (chip has a kind icon and text; dots are decoration with the day's count in an accessible name).
- **Week**: >= 768 px: 7 columns Mon..Sun (week starts Monday; owner may change), each column: all-day items first, then timed items sorted by start, as a stacked list (no hour grid). Phone: a 7-button day strip (each >= 44 px wide and tall, 7 x 51 px at 360 px) and the selected day's list below.
- **Agenda**: day-grouped list from the anchor date, 14 days at a time with "Load next 14 days" link, up to 90 days from anchor. Empty days are omitted. This is the phone default.
- Today is marked; the anchor and ranges are in team dates. No hour grid, no drag to move or resize, no overlap lanes (out of scope).

**Filters** (all in the URL, shareable, parsed by one pure `parseCalendarFilter`; unknown keys and invalid values dropped):

- `show` = comma list of `tasks,milestones,events,timeoff` (default all four; `timeoff` only when RB-06 present).
- `tasks` = `mine` (assignee = me; default) | `all` | `project`. With `project=<KEY>` tasks and milestones are limited to that project and events to that project's events; `tasks=project` without a valid key falls back to `mine`.
- `project=<KEY>` also filters events and milestones (events with no project are hidden when a project is chosen).
- `done=1` shows completed tasks (default off).
- `mine=1` on events: only events I created or attend (default off: all visible events).

**Sources** (one registry `src/lib/server/calendar/sources/*`, each returns `CalendarItem[]` for `[from, to]` with its own cap; the aggregator merges and sorts):

| Kind | Source | Item |
|---|---|---|
| `task` | `tasks` join live non-archived `projects`; `due_on` in range, `deleted_at IS NULL`, status open unless `done=1`; scope per filter | all-day on `due_on`; title `KEY-n title`; link to the task; overdue flag when `due_on < today` and open |
| `milestone` | RB-08 `milestones` (`due_on` in range, live, status `open`; closed shown only with `done=1`) | all-day; link to the milestone page. Table and column names taken from RB-08's merged migration (assumed `milestones.due_on`); engineer adapts and notes any rename |
| `event` | `events` expanded (see below) | timed or all-day; link to event detail |
| `timeoff` | RB-06 approved `leave_requests` and `holidays` (public holiday name as an all-day item; people out as "Name (out)", half days labelled "am"/"pm") | all-day; no link to the request; same fields RB-06's own calendar exposes and nothing else |

**Caps and windows:** a request window is at most 62 days (month view fetches the visible 6-week grid, 42 days; the loader clamps `date` to 2000-01-01..2100-12-31 and the window to 62 days; a larger window is cut, never errors). Each source returns at most 500 rows, the merged result at most 1000 items; when a source hit its cap the page shows "Some items are not shown; narrow the filters". Aggregation is SQL range queries on indexes, no per-row follow-up queries (query-count test: queries per page load constant in the item count).

### 2. Events

`events` rows (see migration). Fields and limits (`CAL_LIMITS` exported const):

- `title` 1-120 (trimmed, control and bidi stripped, single line).
- `description` 0-5000 chars, Markdown; **rendered only through `src/lib/shared/markdown.ts`**; the list and month cells show the title only.
- `location` 0-200 plain text (never auto-linked, never `{@html}`).
- `all_day`: when true, `start_on` and `end_on` (inclusive, `end_on >= start_on`, span at most 31 days); when false, a start date + time and an end date + time in `TEAM_TIME_ZONE`, converted to UTC milliseconds by one pure helper `zonedToUtc(date, time, zone)` (DST-safe via `Intl`, correct for zones with DST even though Jakarta has none); `end_at > start_at`, duration at most 14 days. Dates 2000-01-01..2100-12-31. Time input step 5 minutes.
- `project_id` optional: a live, non-archived project. Choosing a project is organisational only (no permissions).
- `visibility` `team` (default) or `private`.
- `attendees`: 0-50 distinct **active** users, chosen from a picker of active users (the mention-picker source). The creator is implicitly a participant and is not stored as an attendee. No RSVP, no invitation notification this pass. A user deactivated later stays in the table, is shown as "name (inactive)", and is skipped for reminders.
- **Recurrence**: `rec_freq` none|daily|weekly|monthly, `rec_interval` 1-30, end = `until` date or `count` (store `rec_until_on` always; a count is converted to the date of its last occurrence at save). Max span 2 years from the first occurrence, max 500 occurrences, no infinite series. Weekly repeats on the start's weekday only; monthly on the start's day of month, clamped to the last day of shorter months (31 Jan -> 28/29 Feb -> 31 Mar). Timed occurrences keep their wall-clock start and duration in `TEAM_TIME_ZONE`. **Edit** applies to the whole series. **Delete** offers "this occurrence" (writes `event_exceptions`) or "whole series" (soft delete). Editing a single occurrence, "this and following", per-occurrence attendees and exceptions to time are out of scope.
- Counts: at most 2000 live events in total; at most 100 created per user per day (throttle `event-create`, same helper as RB-00 throttle). Expansion is computed per request for the window only (pure `expandEvent(event, from, to, exceptions)`, capped at 500 instances per event, 1000 total); expanded instances are never stored.
- Derived columns `first_on` and `last_on` (first and last team date the event or series touches) are maintained by the app in the same write and give one indexed range predicate: `first_on <= :to AND last_on >= :from`.

### 3. Reminders

A reminder belongs to **one user** and is visible and editable only by that user (it is a private nudge; no one else sees that you set it, not even admin).

| Target | Modes | Fire time |
|---|---|---|
| Task (`target_kind='task'`) | **relative** to the due date: presets "on the due date (09:00)", "1 day before", "2 days before", "1 week before" (offset minutes 0, 1440, 2880, 10080 from 09:00 on `due_on`), or **absolute** (a team-zone date + time) | `zonedToUtc(due_on, 09:00) - offset` for relative; `remind_at` for absolute. A task without a due date refuses relative presets ("Set a due date first") |
| Event (`target_kind='event'`) | **relative** to start: presets "At start", "10 minutes", "30 minutes", "1 hour", "1 day", "1 week" before (offset 0, 10, 30, 60, 1440, 10080); no absolute mode | `start - offset`; for a recurring event a reminder fires for **every** occurrence, one occurrence at a time (see Scheduler); all-day events anchor at 00:00 team time of the day |
| Personal (`target_kind='personal'`) | **absolute** only: `title` 1-120 plain text, optional date + time | `remind_at`; one-off (repeating personal reminders are out of scope) |

Rules: fire time must be at least 60 s in the future at creation ("That time has already passed"); absolute time at most 2 years ahead; offset presets only (a posted offset outside the preset list is refused); 10 reminders per user per target and 200 pending per user (O11); duplicate (same user, target, mode, offset or time) refused by a unique index (idempotent: a second identical create returns the existing one, not an error). A reminder on a task or event the user cannot see (private event of which they are not a participant, deleted, missing id) answers 404 (same as missing).

**Delivery.** A fired reminder inserts one `notifications` row for the owner with `kind='reminder'` (new), `actor_id = user_id` (a reminder is from yourself; RB-03's "never to oneself" rule applies to people-triggered notifications, not here, and the reminder code must not reuse that skip), `target_kind` in `task|event|personal` (new values), `target_id`, `reminder_id`, `occurrence_at`, and a plain-text `summary` (<= 140 chars) snapshotted at fire time, e.g. `OPS-12 Fix login is due tomorrow`, `Design review starts in 1 hour`, or the personal title. The unread badge and `/notifications` list count and show it with no further change besides the new `VERBS`/link mapping (task and event link to the target; personal links to `/reminders`; a target that has since disappeared shows the stored summary with "no longer available"). **E-mail** (O5) and Web Push (O13) are not part of the default build; the e-mail path is specified under Prerequisites and is a flagged follow-up if the owner has not verified a domain.

### 4. Scheduler: `workers/jobs`

A separate Worker `ruby-jobs` because `@sveltejs/adapter-cloudflare` builds `_worker.js` with a `fetch` handler only; a `scheduled` handler would need a custom wrapper around the generated file, fragile on every SvelteKit upgrade.

- `workers/jobs/wrangler.jsonc`: `name: "ruby-jobs"`, same `account_id`, `main: "src/index.ts"`, `compatibility_date` and flags equal to the app, `workers_dev: false`, **no routes, no assets, no R2**, `triggers: { crons: ["* * * * *"] }`, `d1_databases` with binding `DB`, the **same** `database_name` and `database_id` as the app config (no `migrations_dir`: migrations belong to the app config), `vars: { TEAM_TIME_ZONE, REMINDER_EMAIL_FROM: "" }`, `observability: { enabled: true, logs: { invocation_logs: false } }`. `fetch` handler returns 404. Secrets: none.
- `workers/jobs/src/index.ts`: `export default { scheduled(controller, env, ctx) { ctx.waitUntil(runJobs(env.DB, Date.now(), env)) }, fetch: () => new Response('Not found', { status: 404 }) }`. Shared logic lives in `src/lib/server/reminders/` (pure and D1 code imported by both Workers), so Vitest tests the same functions. If `#lib/*` does not resolve in the jobs bundle, use relative imports; the engineer decides and proves it with `wrangler deploy --dry-run`.
- **`runJobs(db, now)`**: (1) `dispatchDue`; (2) when `minute-of-day = 3:15 team time` (once a day): `purgeClosed` (delete closed reminders older than 90 days, at most 500 rows per run, and expired/revoked feed tokens older than 30 days).
- **Claim (idempotent, bounded)**. Per run, up to 3 rounds of 50 reminders, stopping at 20 s elapsed:
  ```
  UPDATE reminders SET claim_token = :tok, claim_until = :now + 300000, attempts = attempts + 1, updated_at = :now
  WHERE id IN (SELECT id FROM reminders
               WHERE done_at IS NULL AND deleted_at IS NULL AND fire_at <= :now
                 AND (retry_at IS NULL OR retry_at <= :now)
                 AND (claim_until IS NULL OR claim_until < :now)
               ORDER BY fire_at LIMIT 50)
  RETURNING *
  ```
  `:tok` is a fresh random id per round. Two overlapping invocations cannot claim the same row (the guard and the row write are one statement). A crashed run's claims expire after 5 minutes (lease) and are retried. This is the `done_at IS NULL` guard the request called the `sent_at IS NULL` guard.
- **Per reminder** (loaded target data through one batched read per round: tasks, events, users by `json_each` id lists, never `IN (list)`), decide an outcome:
  - owner not `active`, reminder or owner target missing/soft-deleted, task `done`/`canceled` (task reminders), event deleted, user no longer a participant of a private event: close as `canceled` (no notification).
  - **Re-derive the fire time from the live target** (due date or event start edited, series changed): if it differs from the stored `fire_at`, update `fire_at` (and clear the claim) and do **not** send now; the next run handles it. This makes the stored `fire_at` a cache, so a hook that missed an edit can only delay, never mis-send. Edit paths (task `patch`/`update`, event update/delete, bulk edits, restore) still recompute `fire_at` of the target's pending reminders in their own batch to keep the index accurate.
  - lag `now - fire_at > 24 h` (O7): `missed`, no notification (recurring: advance to the next occurrence).
  - otherwise **send**: one `db.batch`: (a) `INSERT INTO notifications (...) SELECT ... FROM reminders r WHERE r.id = :id AND r.claim_token = :tok AND r.done_at IS NULL AND r.deleted_at IS NULL ON CONFLICT DO NOTHING` (unique `(reminder_id, occurrence_at)` makes a duplicate send impossible even if the claim guard were bypassed), (b) a closing `UPDATE reminders SET done_at = :now, outcome = 'sent', last_fired_at = :occ, claim_token = NULL WHERE id = :id AND claim_token = :tok AND done_at IS NULL`. For a recurring event reminder (b) instead sets `fire_at` to the next occurrence start minus offset (pure `nextOccurrence(event, afterOccurrence, exceptions)`), `attempts = 0`, `claim_token = NULL`, and closes it as `sent` only when no occurrence remains.
  - D1 error on one reminder: `claim_until = NULL`, `retry_at = now + min(2^attempts, 60) minutes`, `last_error` = a short code (never message text, never user content). At `attempts >= 5` the row closes as `dead` (dead-letter: stays in the table 90 days for inspection, shown to the owner as "Could not be delivered"; no notification). One bad row never blocks the batch (per-row try/catch; the loop continues).
- **Clock skew and time.** Only the jobs Worker's `Date.now()` and D1 data decide; client time is never trusted (client sends a team-zone date and time; the server converts). A backwards clock step cannot double-send (claim guard + unique notification key). Reminders never fire early (`fire_at <= now`). Fire-time offsets are computed with `zonedToUtc`, not `+ 7h`.
- **Cost.** 1440 cron invocations per day, one cheap indexed query each when idle (`reminders_due_idx` partial index). Verify the plan limits (Cron Triggers, D1 reads) against Cloudflare's current docs before the build; do not hard-code quotas.

### 5. iCal feed (O4, default OFF)

- Enabled only when var `CALENDAR_FEED_ENABLED = "1"` (exactly). Off: the route and the account section answer 404 and no token can be created.
- A user creates a feed on `/account`: the server generates 32 random bytes (CSPRNG, 256 bits) base64url, stores **only its SHA-256** in `calendar_feed_tokens` (one active token per user: creating another revokes the first), shows the full URL `https://<app host>/calendar/feed/<token>.ics` **once** with a copy button; "Rotate" and "Revoke" are buttons (POST with CSRF). Revoking or rotating makes the old URL answer 404 at once; a deactivated user's token answers 404.
- `GET /calendar/feed/<token>.ics`: no session; auth is the token. Constant-time compare on the hash lookup (`WHERE token_hash = :h AND revoked_at IS NULL`), unknown/revoked/disabled-owner all answer the same 404 with no body detail. Throttled per client hash (60 requests per hour) with the RB-00 throttle. Response: `text/calendar; charset=utf-8`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="ruby.ics"`. `last_used_at` updated at most once an hour.
- **Content** is what that user would see at `/calendar` with default filters, for the window today - 30 days .. + 180 days, capped at 2000 `VEVENT`s: their own open tasks with due dates (title `KEY-n title`), open milestones, visible events (private ones only where they participate), and, when present, time-off names and holidays. **No descriptions, no attendee lists, no location** in the feed (smaller leak surface; titles only). Recurring events are emitted as expanded instances (distinct `UID` per instance: `<kind>-<id>[-<yyyymmdd>]@<app host>`), avoiding RRULE semantic mismatches. Timed events as UTC (`DTSTART:...Z`), all-day as `VALUE=DATE` with exclusive `DTEND`. `DTSTAMP` = generation time. Text escaped per RFC 5545 (`\\`, `\;`, `\,`, newline -> `\n`), control characters stripped, lines folded at 75 octets with CRLF.
- **Trade-offs, to be accepted by the owner:** a feed URL is a bearer secret that, once a calendar app syncs it, also lives on third-party servers (Google, Apple); anyone holding it reads that user's titles until rotated. It also bypasses Cloudflare Access: **while Access is enabled, the host-wide Access application will block calendar apps**. Options: leave Access off (current state, `ACCESS_DISABLED = "1"`), or add a Cloudflare Access bypass policy for the path `<app host>/calendar/feed/*`; and in `src/hooks.server.ts` the Access JWT check must skip exactly that path prefix when the flag is on (engineer proves the skip is limited to `GET` on that prefix and that no other `/calendar` path skips). The request log line in `hooks.server.ts` must redact the feed token segment (log `/calendar/feed/[redacted]`); invocation logs are already off in `wrangler.jsonc`.

## Out of scope

Full RRULE (BYDAY lists, BYSETPOS, nth weekday, exceptions with changed times), editing one occurrence or "this and following", infinite series, per-attendee RSVP or invitations, free/busy, room or resource booking, meeting links and video conferencing, two-way calendar sync (Google/Outlook/CalDAV write), importing `.ics`, hour-grid week view, drag to move or resize, multiple time zones per user, birthdays and work anniversaries (HR privacy), comments or attachments on events (`TARGET_KINDS` unchanged), repeating personal reminders, snooze, Web Push, SMS, calendar-driven automation, per-project colours, public sharing links, e-mail reminders unless O5 is accepted with a verified sender domain.

## Authorization per action

| Action | Rule |
|---|---|
| `/calendar` view, event detail | `requireUser`. Team events: any active user. Private events: creator or attendee only; anyone else gets 404 (same as missing), and private events never contribute to counts, "+N more", or the feed of others |
| Create event | any active user |
| Edit, delete (series or occurrence) | creator or admin; others 403 on a visible event, 404 on a private one they cannot see. An admin who cannot see a private event gets 404 (O2) |
| Attendee list (read) | whoever can see the event; inactive users labelled |
| Reminders: create, list, delete | the owner only; every query carries `user_id = :actor`; another user's id answers 404. No admin access |
| `/reminders`, task and event reminder panels | `requireUser`; target must be visible to the actor |
| Feed token create, rotate, revoke | `requireUser`, own token only; CSRF as every action; 404 when O4 off |
| `GET /calendar/feed/<token>.ics` | token only, identical 404 for every failure; never a session cookie, never `requireUser` (documented exception to the "every route starts with requireUser" rule; this is the only one and is covered by its own tests) |
| Jobs Worker | no HTTP surface (404); runs with the D1 binding only |

A signed-out request, a deactivated user and an expired session are refused on every route above except the feed. Hidden and missing ids answer identically.

## Concurrency

- **Event update**: `UPDATE events SET ..., updated_at = :new WHERE id = :id AND updated_at = :expected AND deleted_at IS NULL`; zero rows -> re-read: gone -> 404, else 409 "This event changed meanwhile" with the form values kept. `:new = max(:now, :expected + 1)`. The attendee replacement (delete not-in-set, insert new, count guard <= 50) and the recompute of the target's pending reminder `fire_at` are further statements in the **same `db.batch`**, each guarded by `EXISTS (SELECT 1 FROM events WHERE id = :id AND updated_at = :new)` so they apply only when the first statement won.
- **Event delete / occurrence delete**: soft delete idempotent (`WHERE deleted_at IS NULL`); occurrence delete is `INSERT OR IGNORE INTO event_exceptions`; the pending reminders of that occurrence are skipped at fire time (the exception is re-read there).
- **Event create**: the 2000-live cap is `INSERT ... SELECT ... WHERE (SELECT count(*) FROM events WHERE deleted_at IS NULL) < 2000`; attendees inserted from `json_each` with `SELECT id FROM users WHERE status='active'` in the same batch, guarded by the event row existing.
- **Reminder create**: `INSERT ... SELECT ... WHERE (SELECT count(*) ...) < 10 AND (SELECT count(*) ...) < 200 AND EXISTS (live visible target)` plus `ON CONFLICT DO NOTHING` on the dedupe index; two tabs creating the same reminder produce one row.
- **Reminder delete**: `UPDATE ... SET deleted_at = :now WHERE id AND user_id = :actor AND deleted_at IS NULL`; a delete racing a fire either happens before the claim (never sent) or after the send (the notification stays, as notifications are immutable history); the send's guarded insert includes `r.deleted_at IS NULL`.
- **Feed token rotate**: one `db.batch` revokes the active token and inserts the new one; a partial unique index (one active token per user) makes two racing rotations leave exactly one active.
- **Scheduler**: claim and close are guarded statements (see Scheduler); overlapping cron invocations, a retried invocation and a `ctx.waitUntil` that outlives the next minute are safe by construction. No transaction spans calls.
- D1 100-parameter limit: id lists as one JSON parameter and `json_each`; attendee and target lookups join, never `IN (ids)`.

## States

- Calendar: skeleton while navigating; empty window "Nothing scheduled" with "Add event" and the active filters listed; error banner with Retry link; a capped source shows the "Some items are not shown" notice; items for deleted targets disappear on reload.
- Event form: saving disabled and labelled while submitting; field errors inline; 409 banner "changed meanwhile" with "Reload to see the latest" and your text preserved; success only after the server confirms (redirect to the event with a toast).
- Event detail: private badge, inactive attendee labels, "This occurrence was removed" when opened by an exception date.
- Reminders panel/page: pending (with human text "Tomorrow 09:00" in team zone), sent, missed ("Missed while the system was unavailable"), dead ("Could not be delivered"), canceled; empty "No reminders"; at limit "You can have up to 10 reminders here"; past time refused inline; a task without a due date disables relative presets with the reason.
- Notification row: "Reminder" verb, summary text, link; unavailable-target variant.
- Feed section (O4 on): none / active (created date, last used, Rotate, Revoke); the URL appears once after create; O4 off: section absent.

## Mobile layout

Checked at 402x874, 440x956 and 360 px (the existing Playwright viewport spec gains a `/calendar` case, an event form case and a `/reminders` case):

- No page-level horizontal scroll: month grid uses `grid-template-columns: repeat(7, minmax(0, 1fr))`, chips truncate with ellipsis, long titles wrap in lists.
- Every tap target (day cells, day-strip buttons, view switcher, prev/next/today, chips, filter controls, reminder buttons) is at least 44 x 44 px; 7 columns at 360 px minus the 16 px gutters is >= 44 px per cell with a 44 px minimum row height.
- Inputs (including `date`, `time`, `select`, `textarea`) are at least 16 px so iOS does not zoom; the datetime controls are native `date` and `time` inputs (no custom picker library).
- Agenda is the default below 768 px; filters collapse into a "Filters" disclosure (a `<details>`, works without JS) above the list; the view switcher is a three-segment control.
- The sticky bottom tab bar keeps `--sai-bottom` padding; forms' submit bars clear it; the Dynamic Island area is untouched (`--sai-top`).
- Colours via CSS variables for light and dark; item kinds have an icon and a text label, not only colour.

## Acceptance criteria

Level key (docs/ACCEPTANCE.md): [A] Automated, [P] Pass (real Cloudflare runtime, owner or deploy check), [M] Mocked.

Access and general
1. [A] Signed out, deactivated user and expired session are refused on every `calendar/*`, `reminders` and `account` route and action in this PRD (sign-in redirect for pages, 403/401 for actions); only the feed route is session-free.
2. [A] Hidden and missing ids (event, reminder, private event of someone else) give the same status and body.
3. [A] Every form action requires the CSRF origin check already in `src/lib/server/csrf.ts` and works without JavaScript.

Calendar
4. [A] Given tasks with `due_on` today, in 5 days and in another month, the month window shows exactly those in range for `tasks=mine`; `tasks=all` adds others' tasks; `tasks=project&project=OPS` limits to OPS; deleted tasks and tasks of archived projects never appear; done/canceled appear only with `done=1`.
5. [A] RB-08 milestones with `due_on` in range appear and link to their page; closed ones only with `done=1`; a soft-deleted milestone never appears.
6. [A] Time off: with RB-06 present, approved leave and holidays appear as names / holiday names only, never pending or rejected requests, never type or reason (payload scan); without RB-06 the `timeoff` source is absent and `show=timeoff` is ignored. If RB-06 is not merged at build the engineer records the follow-up in TASKS and ships without it.
7. [A] View and date parsing: invalid `view`, `date`, `show`, `project` values fall back to defaults; a window larger than 62 days is clamped; a date outside 2000-2100 is clamped; month grid for Feb in a leap year and a Monday-start week are correct.
8. [A] Per source cap 500 and merged cap 1000 hold with 1200 seeded tasks; the "not all shown" notice appears; query count per load is constant (query-count test with 10 vs 500 items).
9. [P] At 402x874, 440x956 and 360 px: no horizontal page scroll on month, week, agenda, event form, event detail and `/reminders`; tap targets >= 44 px; agenda is shown by default below 768 px and the month at 768 px and up; without `view` both blocks are in the HTML and exactly one is visible per width.

Events
10. [A] Create a timed event 2026-11-02 14:00-15:30 Asia/Jakarta: stored `start_at` = 2026-11-02T07:00:00Z, shown as 14:00 WIB; reload keeps it. An all-day event over 3 days shows on each of the 3 days and not the 4th.
11. [A] Limits: title 0 or 121 chars refused; description 5001 refused; location 201 refused; end before start refused; duration over 14 days (timed) or span over 31 days (all-day) refused; 51 attendees refused; a deactivated or unknown user as attendee refused; a project that is archived, deleted or missing refused; the 2001st live event refused.
12. [A] Markdown: an event description with `<script>`, `<img onerror>`, `javascript:`, `data:` and `vbscript:` links, mixed-case and entity-encoded variants renders inert on the detail page; the calendar list/month never render the description; title, location and attendee names are text.
13. [A] Recurrence: weekly every 2 weeks until a date, daily x10, monthly on the 31st (Jan 31, Feb 28/29, Mar 31 ...), 500-occurrence and 2-year caps refused over the limit, an interval of 0 or 31 refused, an infinite series refused; expansion only inside the window; one deleted occurrence disappears and the others stay; whole-series delete removes all.
14. [A] Privacy: a private event is returned to creator and attendees only; a third member and an admin get 404 on its URL and never see it in `/calendar`, counts, "+N more" or the feed; a team event is visible to all.
15. [A] Edit/delete: creator and admin may; a non-creator member gets 403 on a team event; two tabs editing the same event: the second save gets 409 and nothing is overwritten; editing changes attendees atomically (a failed first statement leaves attendees unchanged).
16. [A] Soft delete: a deleted event is gone from the calendar, its detail answers 404, its pending reminders close `canceled` when due; there is no restore UI this pass (state it).

Reminders
17. [A] Create: task relative "1 day before" on a task due 2026-11-05 gives `fire_at` = 2026-11-04T02:00:00Z (09:00 WIB minus a day); absolute task reminder, event "10 minutes", and personal reminders store the right UTC; a past time, more than 2 years ahead, an unknown preset offset, a relative preset on a task with no due date, and a reminder on an event the user cannot see are refused; identical create twice leaves one row; the 11th reminder on one target and the 201st pending refused (concurrent creates at the limit: exactly the allowed number succeed).
18. [A] Ownership: user B cannot list, read, delete or learn the existence of user A's reminder (404); admin neither.
19. [A] Dispatch: a due reminder produces exactly one `notifications` row of kind `reminder` for its owner with the summary and the right link, increments the unread badge, and closes as `sent`; running `dispatchDue` twice, or two overlapping runs, yields one notification; reminders with `fire_at` in the future are untouched.
20. [A] Never early: with `now = fire_at - 1 ms` nothing is sent; with `now = fire_at` it is.
21. [A] Batch bound: 120 due reminders are processed 50 per round, at most 3 rounds per run; the rest are picked up by the next run in `fire_at` order; the 20 s budget stops the loop (injected clock).
22. [A] Retry and dead-letter: a forced D1 failure on one reminder sets `retry_at` with growing backoff, leaves the rest of the batch processed, and at the 5th failed attempt closes the row `dead` with a short `last_error` code and no message text; a claim whose lease expired is re-claimed.
23. [A] Late and clock: a reminder 25 h late closes `missed` with no notification; 23 h late is sent; a clock that steps back one hour between runs causes no duplicate (unique key); `fire_at` comes from `zonedToUtc`, verified for a zone with DST in a unit test.
24. [A] Live-target rules: editing a task's due date after the reminder was set moves its `fire_at` (in the edit batch) and, if an edit path missed it, the job reschedules rather than sends at the stale time; a done or canceled task, a deleted task, a deleted event, a deactivated owner and a user removed from a private event close the reminder `canceled` without notification; an event moved earlier past `now` is not sent as late.
25. [A] Recurrence: a reminder on a weekly event fires once per occurrence in order (3 simulated weeks give 3 notifications with distinct `occurrence_at`), skips a deleted occurrence, and closes `sent` after the last occurrence; editing the series recomputes the next `fire_at`.
26. [A] Personal reminder: fires once at `remind_at` and links to `/reminders`.
27. [A] Retention: closed reminders older than 90 days are purged (500 per run); pending ones never; the daily purge runs once per day.
28. [P] Local cron simulation: with `wrangler dev` of the jobs Worker and `--test-scheduled`, `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` against local D1 turns a due seeded reminder into a notification visible at `/notifications`. Real cron firing on Cloudflare is verified once after the first deploy (owner or orchestrator, with the deploy log line).

Notifications table migration
29. [A] Applying `0011` to a database holding `notifications` rows of all three old kinds keeps every row byte-for-byte (id, user, kind, actor, target, comment, created_at, read_at), keeps the unread count, and the new CHECK accepts `reminder` and rejects an unknown kind and an unknown target kind; the index `notifications_user_idx` exists; `PRAGMA foreign_key_check` returns no rows; RB-03 tests all pass unchanged.

Feed (when `CALENDAR_FEED_ENABLED=1`)
30. [A] With the flag unset: feed route and account section answer 404 and no token can be created. With it on: create shows the URL once; reload shows no token; DB holds only the SHA-256; rotate invalidates the old URL at once; revoke and a deactivated owner give 404; wrong, empty and malformed tokens all give the identical 404 and are throttled.
31. [A] Feed content: valid RFC 5545 (CRLF, folded lines at 75 octets, escaped text, stable `UID`s, `DTSTAMP`), contains only that user's visible items, no descriptions, locations or attendees, no private events of others, at most 2000 events, window today-30d..+180d; a title with `\n`, `;`, `,`, `\` and control characters cannot inject a property.
32. [A] Headers on the feed: `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `nosniff`; the request log never contains the token; the Access skip applies only to `GET /calendar/feed/*` (a test proves `/calendar` and `/calendar/feed` without a token still need the JWT when Access is on).

Scheduler and deploy
33. [A] `scripts/deploy.test.ts`: `buildSteps(false)` order is bookmark, apply migrations, build, deploy jobs Worker, deploy app Worker; `--dry-run` passes `--dry-run` to both deploys and skips the remote steps; `deployProblems` fails when the jobs config's `database_id` differs from the app's.
34. [A] `workers/jobs/wrangler.jsonc` has a cron trigger, no routes, no `workers_dev`, the same D1 id, and `wrangler deploy -c workers/jobs/wrangler.jsonc --dry-run` succeeds in `gates`.

General
35. [A] `npm run gates` passes; `check` includes the jobs Worker sources.
36. [P] Playwright viewport spec covers criterion 9.

Engineering checklist items carried in: 100-parameter limit (criteria 11, 21, 17), bounded work and pagination (8, 21), concurrency proof (15, 17, 19), tombstones (4, 5, 16), Markdown safety (12), plain-text rendering (12, 31), secrets stay server side and never logged (30, 32), migrations never edited and a bookmark before the remote apply (33), UTC ms timestamps and one `now()` helper (10, 23).

## Test plan

Unit (Vitest): `zonedToUtc` and its inverse (Jakarta, a DST zone, day boundaries); `expandEvent`/`nextOccurrence` table (daily, weekly, monthly clamp, leap day, caps, exceptions, window edges); `parseCalendarFilter` and window clamp; `reminderFireAt` for task, event and absolute; offsets whitelist; limit validators; summary builder (length, control characters, no Markdown); iCal builder (escaping, folding at 75 octets with multibyte, injection strings, UID stability); token generator length and hashing; `buildSteps`/`deployProblems`.

Integration (`openLocalD1`, `fakeEvent`, new `test/helpers/seed-calendar.ts`): every authorization row with member, creator, attendee, admin, deactivated; event update 409 race; reminder create limit and dedupe races; scheduler suite with an injected clock (`dispatchDue(db, now)`): single send, double run, overlap, 120-row batching, failure/retry/dead, lease expiry, late/missed, clock step back, each live-target cancellation, recurrence walk, purge; edit-path hooks (task patch, bulk edit, event update) moving `fire_at`; migration test applying 0000..0011 over seeded `notifications`; query-count tests for the calendar load; feed route tests; RB-01, RB-03 and RB-08 regression suites unchanged.

Local cron simulation: `npm run jobs:dev` (new script: `wrangler dev -c workers/jobs/wrangler.jsonc --test-scheduled --persist-to .wrangler/state`) plus the curl above, documented in `docs/RUNBOOK.md`. Not part of `gates` (like the Playwright spec).

Browser (Playwright, outside `gates`): viewport spec additions for `/calendar` (agenda, month, week), event form, `/reminders` at the three sizes; dark mode screenshot review by QA.

Red team focus: feed token entropy, storage, timing, leakage in logs, referrer and caches; Access bypass path scoping; private-event enumeration through counts, "+N more", `ids`, feed and notification summaries; reminder summary and iCal injection; IDOR on reminders and events; claim race and double-send; ability for one user to create unbounded cron work (caps); the jobs Worker having no HTTP surface; migration data loss.

## Architecture notes

**New code**
- `src/lib/shared/enums.ts`: add `EVENT_VISIBILITIES = ['team','private']`, `REC_FREQS = ['daily','weekly','monthly']`, `REMINDER_TARGET_KINDS = ['task','event','personal']`, `REMINDER_OUTCOMES = ['sent','missed','canceled','dead']`, `NOTIFICATION_TARGET_KINDS = [...TARGET_KINDS, 'event', 'personal']`; append `'reminder'` to `NOTIFICATION_KINDS`. `TARGET_KINDS` itself stays `['task','page']` (comments and attachments use it).
- `src/lib/shared/calendar.ts` (pure): `zonedToUtc`, `utcToZoned`, date arithmetic with `Date.UTC`, `expandEvent`, `nextOccurrence`, `parseCalendarFilter`, `CAL_LIMITS`, `REMINDER_PRESETS`.
- `src/lib/server/calendar/{repo.ts,sources/*.ts,ical.ts,feed.ts}`; `src/lib/server/events/repo.ts`; `src/lib/server/reminders/{repo.ts,dispatch.ts,summary.ts}` (imported by both Workers).
- `workers/jobs/{wrangler.jsonc,src/index.ts,tsconfig.json}`.
- `src/routes/(app)/calendar/**`, `src/routes/(app)/reminders/**`, `src/routes/calendar/feed/[file]/+server.ts`, account section, task detail reminder panel, `src/lib/ui/calendar/**`.
- Schema: tables below in `src/lib/server/db/schema.ts` (`notifications` rewritten with new columns and CHECKs).

**Reuse**: `requireUser`, `src/lib/shared/markdown.ts`, `todayIn`/`isValidDueOn` from `tasks/dates.ts`, `newId`, `isUniqueViolation`, `errorLabel`, the throttle helper, the active-user picker used for mentions and assignees, `canManageProject` is **not** used (O3), `UNREAD_COUNT_CAP` unchanged.

**Edits to existing code**: `notifications/repo.ts` (`VERBS`, `NotificationView` for `reminder`, joins on `summary`), `targets/resolve.ts` (event and personal targets, read-only link building), `src/hooks.server.ts` (feed-path Access skip and log redaction, only when the flag is on), `tasks/repo.ts` patch/update/bulk/restore paths (add a `reminderRescheduleStatement` to the batch), `scripts/deploy.ts` and `scripts/deploy.test.ts`, `package.json` (`jobs:dev`, `check` covers `workers/jobs`), `tsconfig` includes, `docs/RUNBOOK.md`, `CLAUDE.md` (after O1: "one app Worker plus one jobs Worker `ruby-jobs` with a Cron Trigger; reminders are the only background job; no Queues"; new routes `/calendar`, `/reminders`).

**`wrangler` and deploy changes**
- New `workers/jobs/wrangler.jsonc` as above. The app's `wrangler.jsonc` gains vars `CALENDAR_FEED_ENABLED: ""` and `REMINDER_EMAIL_FROM: ""` (empty = off); no other app change. `npm run types:cf` also generates jobs bindings (`wrangler types -c workers/jobs/wrangler.jsonc`).
- `scripts/deploy.ts` `buildSteps(dryRun)`: (1) Time Travel bookmark, (2) `wrangler d1 migrations apply ruby --remote`, (3) `vite build`, (4) **`wrangler deploy -c workers/jobs/wrangler.jsonc`** (jobs first), (5) `wrangler deploy` (app). Why jobs first: it can start with the new schema right after migrations; a failure there stops the deploy before the app ships, and a jobs Worker that runs with no reminders yet is harmless. `--dry-run` skips (1)-(2) and passes `--dry-run` to (4) and (5). `deployProblems` additionally reads `workers/jobs/wrangler.jsonc` and refuses a different or placeholder `database_id`. The jobs Worker is compatible with the pre-migration app (migration is additive and the rebuilt table keeps its columns), and the app is compatible with the jobs Worker absent (reminders just wait up to 24 h, then `missed`).
- Rollback: Time Travel bookmark restores D1; `wrangler rollback` for each Worker; a note in `docs/RUNBOOK.md`.

**Migration `0011_calendar_reminders.sql`** (hand-written SQL; generate the Drizzle snapshot afterwards and hand-check that the generated file matches the intended DDL. The numbered file is applied by `wrangler d1 migrations apply`; do not edit applied migrations).

```
-- 1. New tables. `reminders` first: notifications (rebuilt below) references it.
CREATE TABLE `events` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text REFERENCES `projects`(`id`),
  `title` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `location` text NOT NULL DEFAULT '',
  `all_day` integer NOT NULL DEFAULT 0,
  `start_on` text, `end_on` text,            -- all-day: inclusive team dates
  `start_at` integer, `end_at` integer,      -- timed: UTC ms, end exclusive
  `first_on` text NOT NULL, `last_on` text NOT NULL,   -- team dates the event or series touches
  `visibility` text NOT NULL DEFAULT 'team',
  `rec_freq` text, `rec_interval` integer NOT NULL DEFAULT 1, `rec_until_on` text,
  `created_by` text NOT NULL REFERENCES `users`(`id`),
  `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `deleted_at` integer,
  CONSTRAINT `events_all_day_check` CHECK(`all_day` IN (0,1)),
  CONSTRAINT `events_visibility_check` CHECK(`visibility` IN ('team','private')),
  CONSTRAINT `events_rec_freq_check` CHECK(`rec_freq` IS NULL OR `rec_freq` IN ('daily','weekly','monthly')),
  CONSTRAINT `events_rec_interval_check` CHECK(`rec_interval` BETWEEN 1 AND 30),
  CONSTRAINT `events_rec_until_check` CHECK((`rec_freq` IS NULL) = (`rec_until_on` IS NULL)),
  CONSTRAINT `events_shape_check` CHECK(
    (`all_day` = 1 AND `start_on` IS NOT NULL AND `end_on` IS NOT NULL AND `start_at` IS NULL AND `end_at` IS NULL)
    OR (`all_day` = 0 AND `start_at` IS NOT NULL AND `end_at` IS NOT NULL AND `start_on` IS NULL AND `end_on` IS NULL))
);
CREATE INDEX `events_range_idx` ON `events` (`first_on`, `last_on`) WHERE `deleted_at` IS NULL;
CREATE INDEX `events_project_idx` ON `events` (`project_id`) WHERE `deleted_at` IS NULL;
CREATE INDEX `events_creator_idx` ON `events` (`created_by`);

CREATE TABLE `event_attendees` (
  `event_id` text NOT NULL REFERENCES `events`(`id`),
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `created_at` integer NOT NULL,
  PRIMARY KEY (`event_id`, `user_id`)
);
CREATE INDEX `event_attendees_user_idx` ON `event_attendees` (`user_id`);

CREATE TABLE `event_exceptions` (            -- one deleted occurrence of a series
  `event_id` text NOT NULL REFERENCES `events`(`id`),
  `on_date` text NOT NULL,
  `created_by` text NOT NULL REFERENCES `users`(`id`),
  `created_at` integer NOT NULL,
  PRIMARY KEY (`event_id`, `on_date`)
);

CREATE TABLE `reminders` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `target_kind` text NOT NULL,                -- 'task' | 'event' | 'personal'
  `target_id` text,                           -- null only for 'personal'
  `mode` text NOT NULL,                       -- 'relative' | 'absolute'
  `offset_min` integer,                       -- relative: minutes before the anchor
  `remind_at` integer,                        -- absolute: UTC ms
  `title` text NOT NULL DEFAULT '',           -- personal only
  `fire_at` integer NOT NULL,                 -- next fire time, UTC ms (a cache of the live target)
  `last_fired_at` integer,                    -- occurrence start (UTC ms) last delivered
  `claim_token` text, `claim_until` integer,
  `attempts` integer NOT NULL DEFAULT 0, `retry_at` integer, `last_error` text,
  `done_at` integer, `outcome` text,
  `email_sent_at` integer,                    -- stays NULL unless O5 is enabled
  `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `deleted_at` integer,
  CONSTRAINT `reminders_target_kind_check` CHECK(`target_kind` IN ('task','event','personal')),
  CONSTRAINT `reminders_mode_check` CHECK(`mode` IN ('relative','absolute')),
  CONSTRAINT `reminders_target_check` CHECK((`target_kind` = 'personal') = (`target_id` IS NULL)),
  CONSTRAINT `reminders_shape_check` CHECK(
    (`mode` = 'relative' AND `offset_min` BETWEEN 0 AND 10080 AND `remind_at` IS NULL)
    OR (`mode` = 'absolute' AND `remind_at` IS NOT NULL AND `offset_min` IS NULL)),
  CONSTRAINT `reminders_outcome_check` CHECK(`outcome` IS NULL OR `outcome` IN ('sent','missed','canceled','dead')),
  CONSTRAINT `reminders_done_check` CHECK((`done_at` IS NULL) = (`outcome` IS NULL))
);
CREATE INDEX `reminders_due_idx` ON `reminders` (`fire_at`) WHERE `done_at` IS NULL AND `deleted_at` IS NULL;
CREATE INDEX `reminders_user_idx` ON `reminders` (`user_id`, `done_at`, `fire_at`) WHERE `deleted_at` IS NULL;
CREATE INDEX `reminders_target_idx` ON `reminders` (`target_kind`, `target_id`) WHERE `deleted_at` IS NULL;
CREATE UNIQUE INDEX `reminders_dedupe_uq` ON `reminders`
  (`user_id`, `target_kind`, ifnull(`target_id`, ''), `mode`, ifnull(`offset_min`, -1), ifnull(`remind_at`, -1), `title`)
  WHERE `done_at` IS NULL AND `deleted_at` IS NULL;

CREATE TABLE `calendar_feed_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `token_hash` text NOT NULL,                 -- SHA-256 hex of the 32-byte token; the token is never stored
  `created_at` integer NOT NULL, `last_used_at` integer, `revoked_at` integer
);
CREATE UNIQUE INDEX `calendar_feed_tokens_hash_uq` ON `calendar_feed_tokens` (`token_hash`);
CREATE UNIQUE INDEX `calendar_feed_tokens_active_uq` ON `calendar_feed_tokens` (`user_id`) WHERE `revoked_at` IS NULL;

CREATE TABLE `user_calendar_prefs` (
  `user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`),
  `email_reminders` integer NOT NULL DEFAULT 0 CHECK(`email_reminders` IN (0,1)),
  `updated_at` integer NOT NULL
);

-- 2. Rebuild `notifications` (SQLite cannot alter a CHECK in place).
--    Nothing references notifications, so no other table is affected. D1 enforces foreign keys and ignores
--    `PRAGMA foreign_keys = off`; the first statement defers FK checks to the end of the migration transaction.
PRAGMA defer_foreign_keys = on;
DROP TABLE IF EXISTS `notifications_new`;      -- re-runnable after a partial failure
CREATE TABLE `notifications_new` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `kind` text NOT NULL,
  `actor_id` text NOT NULL,
  `target_kind` text NOT NULL,
  `target_id` text NOT NULL,
  `comment_id` text,
  `summary` text,                              -- plain text <= 140, reminders only
  `reminder_id` text,
  `occurrence_at` integer,                     -- the occurrence a reminder was for (UTC ms)
  `created_at` integer NOT NULL,
  `read_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`reminder_id`) REFERENCES `reminders`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT "notifications_kind_check" CHECK("kind" in ('mention', 'assigned', 'comment', 'reminder')),
  CONSTRAINT "notifications_target_kind_check" CHECK("target_kind" in ('task', 'page', 'event', 'personal')),
  CONSTRAINT "notifications_reminder_check" CHECK(("kind" = 'reminder') = ("reminder_id" IS NOT NULL))
);
INSERT INTO `notifications_new`
  (`id`,`user_id`,`kind`,`actor_id`,`target_kind`,`target_id`,`comment_id`,`created_at`,`read_at`)
  SELECT `id`,`user_id`,`kind`,`actor_id`,`target_kind`,`target_id`,`comment_id`,`created_at`,`read_at`
  FROM `notifications`;
DROP TABLE `notifications`;                    -- its index notifications_user_idx is dropped with it
ALTER TABLE `notifications_new` RENAME TO `notifications`;
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`, `read_at`, `created_at`);
CREATE UNIQUE INDEX `notifications_reminder_uq` ON `notifications` (`reminder_id`, `occurrence_at`) WHERE `reminder_id` IS NOT NULL;
```

Notes for the engineer on the rebuild: keep the old column order for the copied columns; the `ALTER TABLE ... RENAME` rewrites FK references in other tables (none point at `notifications`); keep the constraint names `notifications_kind_check` and `notifications_target_kind_check` so the Drizzle schema matches; the migration test (criterion 29) is the proof; take the D1 Time Travel bookmark first (`scripts/deploy.ts` already does); no destructive data change, so the "no deploy on a destructive migration" rule is not triggered, but state this in the deploy note.

## Prerequisites

- **Owner**: answer O1-O14 (O1 is blocking). No secret and no new binding is required for the default build (in-app reminders, feed off).
- **Cloudflare**: Workers Paid or the plan limits for Cron Triggers confirmed against current docs (the memory file notes Workers Paid exists for another project; confirm for this account). Name `ruby-jobs` must be free in the account. The deploying machine's Wrangler login must be allowed to deploy a second Worker (same token).
- **O4 (feed)**: set var `CALENDAR_FEED_ENABLED = "1"`; if Cloudflare Access is re-enabled, add an Access bypass policy for `<app host>/calendar/feed/*` (documented in `docs/RUNBOOK.md`).
- **O5 (e-mail)**: Cloudflare Email Sending is on the account but a **sender domain must be verified** (DNS records in the zone) and the sender address chosen (`REMINDER_EMAIL_FROM`, e.g. `reminders@<verified domain>`); then the engineer adds a send binding to the jobs Worker, `user_calendar_prefs.email_reminders` toggle in `/account`, one e-mail per delivered reminder (subject and body are the plain `summary`, no Markdown, no links with tokens, an unsubscribe note pointing to `/account`), `email_sent_at` guarded (`UPDATE ... WHERE email_sent_at IS NULL`) so a retry never mails twice, and e-mail failure never blocks or repeats the in-app notification. Until then the toggle is hidden and `REMINDER_EMAIL_FROM` stays empty. `CLAUDE.md` "no e-mail sending beyond what an owner decision adds" is satisfied by recording this decision.
- **Missing behaviour**: with the jobs Worker undeployed, reminders can be created and show "Pending" but nothing fires (a banner on `/reminders` is not possible without a heartbeat; instead the jobs Worker writes `app_meta` key `jobs_last_run` each run and `/reminders` shows "Reminders may be delayed: the scheduler has not run for N minutes" when the value is older than 10 minutes or missing). With RB-06 absent the time-off source is skipped; with RB-08 absent the milestone source is skipped (engineer feature-probes the migration list, not by catching SQL errors at runtime).
- `TEAM_TIME_ZONE` (already set) is required by both Workers; an invalid zone fails the deploy dry run (validated at start, falls back to UTC with a loud log line in dev only).

## Tracker impact

- New `docs/TASKS.md` items: "RB-09 Calendar and reminders: `/calendar`, events with recurrence, reminders, `ruby-jobs` Worker" (Claude); "Decide RB-09 owner questions O1-O14, O1 first" (You); "Confirm cron plan limits and deploy `ruby-jobs`" (You, at first deploy); optional "Verify an e-mail sender domain" and "Enable the calendar feed" (You, only if O4/O5 accepted); follow-up "RB-09 time-off source" if RB-06 is not merged at build.
- `CLAUDE.md` amended after O1 (architecture, boundaries, route list).
- `docs/ACCEPTANCE.md` new rows: reminder single-delivery and claim (Automated), private-event non-disclosure (Automated), `0011` notification rebuild keeps rows (Automated), real cron fires after deploy (Pass, first production deploy), viewport spec for the calendar (Pass).
- `docs/RUNBOOK.md`: jobs Worker deploy order, `jobs:dev` cron simulation, rollback of two Workers, feed token rotation after a suspected leak.
