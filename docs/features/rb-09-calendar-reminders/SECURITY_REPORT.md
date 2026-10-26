# RB-09 Calendar and reminders — security report

Reviewer: red-team-pentester. Scope: `git diff main..HEAD` at the RB-09 tip (commit `cd21fd1`, "cycle 1c"): server code
in `src/lib/server/{calendar,events,reminders}/`, the calendar sources (tasks, milestones, events, time off), the
edits to `notifications/repo.ts`, `tasks/repo.ts` and `pm/bulk.ts`, the routes `/calendar/**`, `/reminders`, the
reminder panels on the task and event pages, the e-mail toggle on `/account`, the jobs Worker `workers/jobs`
(`scheduled`, dispatch, `send_email`), migration `0011_calendar_reminders.sql`, and `scripts/deploy.ts`. Also checked
against `docs/ENGINEERING_CHECKLIST.md`. The iCal feed (O4) is off and was not built, so it is out of scope.

## Verdict: PASS

There are no medium or high findings. Three low findings are listed below so they are tracked. Informational notes
follow them.

## Findings

### L1 (low, availability): private events can fill the global 2000-event cap, and no admin can remove them

- **Where:** `src/lib/server/events/repo.ts:161` (the `eventsLiveMax` guard counts every live event, private ones
  included). The delete path, `deleteEvent` at `repo.ts:314-331`, runs through `eventVisibleSql`
  (`src/lib/server/events/timing.ts:38-40`). Under owner decision O2, an admin cannot see, and so cannot delete,
  another user's private event.
- **Scenario:** a member creates 100 private events a day, the per-user daily cap. After 20 days, the instance
  holds 2000 live events, or sooner if two accounts do this. From then on, every create, the admin's included,
  answers "Ruby holds at most 2000 events". The admin cannot see or delete the events. Deactivating the author
  does not free the cap either, because the events stay live. The only remedy is manual SQL on D1.
- **Repro:** `test/security/rb09-d1.test.ts` › "PROOF L1". The test seeds 1999 private events plus 1. After that,
  the admin's and Ana's creates return `total_limit`, the admin's `deleteEvent` returns `not_found`, and the
  creates are still refused after the author is deactivated.
- **Fix (owner choice):** pick one of these.
  - Count the cap per creator (for example, 300 live events per user) instead of globally.
  - Exclude events whose creator is deactivated from the cap and from every list.
  - Give admins a content-free "purge events of a deactivated user" action. It must never show titles, so O2
    still holds.

### L2 (low, availability): reminder create + delete has no throttle; soft-deleted rows pile up faster than the purge

- **Where:** `src/lib/server/reminders/repo.ts:106-195` (`createReminder`) and `:198-212` (`deleteReminder`), plus the
  purge at `src/lib/server/reminders/jobs.ts:28` and `:47-60` (500 rows, once a day at 03:15).
- **Scenario:** the 200-pending cap and the dedupe index count only live rows (`done_at IS NULL AND deleted_at IS
  NULL`). A script can therefore loop "create, delete" without limit. Every iteration leaves a soft-deleted row
  for 90 days, and the purge then removes at most 500 rows a day. One member running a few requests a second adds
  hundreds of thousands of rows a day to D1. That costs storage and slows the `reminders_user_idx` and
  `reminders_target_idx` scans. Events do not have this problem, because their daily cap counts deleted rows too.
- **Repro:** `rb09-d1.test.ts` › "PROOF L2". 300 create and delete cycles all succeed and leave 300 rows. The
  purge removes nothing at 89 days and 300 rows at 91 days.
- **Fix:** use the same pattern as the event cap. Add `AND (SELECT count(*) FROM reminders WHERE user_id = ?2 AND
  created_at > ?10 - 86400000) < N` (for example, N = 500) to the guarded INSERT, and map a miss to a 429. Also
  let the purge drop rows that were deleted while pending sooner, or raise `PURGE_MAX`.

### L3 (low, hardening): the `send_email` binding is unrestricted, and wrangler's deploy output shows deployment values

- **Where:** `workers/jobs/wrangler.jsonc:36` (`"send_email": [{ "name": "EMAIL" }]`; the dry run prints
  `env.EMAIL (unrestricted)`), and `scripts/deploy.ts:256` / `:266` (wrangler's stdout is passed straight to the
  terminal).
- **Scenario:**
  - **Binding.** The code sends only to the owner's own `users.email`, from `REMINDER_EMAIL_FROM`. That is proven
    below. However, the binding itself allows any sender address and any recipient. A future bug, or a
    compromised dependency in the jobs bundle, could mail anyone as any address on the verified domain.
  - **Deploy output.** `npm run deploy` (and `--dry-run`) never prints a value itself. Wrangler's bindings table,
    though, prints var values: `APP_HOST` for the jobs Worker, and for the app `ACCESS_TEAM_DOMAIN` plus a
    truncated `ACCESS_AUD`. These end up in terminal scrollback and CI logs. The app part predates RB-09; the
    jobs Worker adds `APP_HOST`.
- **Repro:** run `node scripts/deploy.ts --dry-run` with a real `.deploy.env` and read the "Binding" tables. The
  dry run on this tip exited 0. The script's own lines carried only paths. Wrangler's table showed the host and
  the team domain.
- **Fix:**
  - **Binding.** Render `allowed_sender_addresses: ["<RUBY_REMINDER_EMAIL_FROM>"]` into the jobs config at deploy
    time, and drop the binding entirely while the sender is empty.
  - **Deploy output.** Optionally pipe the wrangler deploy steps through a filter that masks the rendered values,
    or document in `docs/RUNBOOK.md` that deploy logs are not to be shared.

## Informational

- **Poison rows are never dead-lettered if the Worker dies mid-run.** `attempts` grows at each claim
  (`dispatch.ts:80`), but the `dead` close only happens in `fail()` (`dispatch.ts:406`). If an invocation is killed
  (CPU or wall limit) while it holds a row, the row is re-claimed every 5 minutes forever, together with its 49
  round-mates. None of the code paths I checked can be made to crash on user data, so this is robustness only.
  Possible hardening: in the claim loop, close rows with `attempts > MAX_ATTEMPTS` as `dead` before planning them.
- **The summary of a sent reminder notification outlives the sender's visibility.** Bo, removed from a private
  event, keeps the summary line of a reminder that was already delivered to him; the link goes away. This matches
  the PRD ("notifications are immutable history").
- **Over-long astral descriptions are cut, not refused.** `parseEventForm` slices the description to 10 000 UTF-16
  units before counting code points (`events/validation.ts:153`). A 5001-emoji description is stored as 5000 emoji
  instead of being refused. This is not a security issue.

## What was attacked and held

- **Private events:** the defence holds for third members and for admins. They get nothing in any calendar view or
  filter (month, week, agenda, no view, `mine=1`, `show=events`, `tasks=all&done=1`), and nothing in `capped`, in
  the detail page (including `?on=`), in edit, update, remove, removeOccurrence or reminderAdd (each answers 404
  with the same body as a missing id), and nothing through repository calls. A payload scan of each load finds no
  title, location, description or id. An attendee removed through `updateEvent` loses the event at once (detail,
  calendar, `/reminders`). Notification links to events are filtered by visibility. `__data.json` is the same load
  output, and the hook marks it `private, no-store`.
- **IDOR:** another user's reminder id, the admin's included and in upper case, answers 404 on `/reminders?/remove`,
  `task ?/reminderRemove` and `event ?/reminderRemove`, and the row stays. No other user's ids appear in another
  user's `/reminders`, task panel or event panel. Every reminder query carries `user_id`. Event and occurrence
  writes are guarded in SQL (visible, live, creator or admin). `removeOccurrence` checks that the date is a real
  occurrence.
- **Reminder spam and limits:** under 20 concurrent requests the caps hold exactly: 10 per target, 200 pending, 100
  events per user per day (and deleting events does not reset it). 20 identical creates leave one row. Tampered
  offsets are refused: wrong preset family, `0x10`, `1e3`, `1440.0`, leading zeros, empty values, and `absolute`
  on an event. So are times that are past, under a minute ahead, more than two years ahead, or in 2000 or 2100,
  and malformed dates and times. Recurrence is refused over 500 occurrences or 2 years, for intervals outside
  1..30, for an unknown frequency, and for a series without an end or ending after 2100-12-31. A month view with 30
  daily 500-occurrence series returns exactly 1000 items, flagged `capped`. URL dates are clamped and every read
  is 62 days at most. Reminders only ever notify their own owner, so there is no fan-out to others.
- **Jobs Worker:**
  - **Claims and leases.** A run stalled past its 5-minute lease cannot double-send. The next run re-claims the row
    and sends once (one notification, one mail). The stalled run's guarded writes then change nothing. Before the
    lease expires, nobody else can claim the row. 20 overlapping runs over 60 due reminders deliver each one exactly
    once. A delete that lands between the claim and the send delivers nothing. The unique key on
    `(reminder_id, occurrence_at)` refuses a duplicate even outside the claim guard.
  - **Missed edit hooks.** Even when an edit hook is bypassed, the live-target re-check cancels the reminder: an
    event flipped to private, a deleted attendee row, a deleted task, a deleted project, a deactivated owner
    (no mail either).
  - **Backoff and dead-letter.** Covered by the engineer's suite (`reminders-dispatch.test.ts`, criterion 22), and
    re-read.
  - **No HTTP surface.** `fetch` answers 404, `workers_dev` is false, and the config has no route, no assets and no
    R2.
- **E-mail:**
  - **Recipients.** Mail goes only to the opted-in owner's own address. A participant's private event reminder mails
    only that participant, never the creator or other attendees. Users who have not opted in get in-app only.
  - **Injection.** A task title carrying `\r\nBcc:` and `Content-Type:` lines plus HTML yields a single-line subject
    and a three-part text body. The message has only the `from`, `to`, `subject` and `text` fields (no html part).
  - **Links.** Links come only from the `APP_HOST` var, lower-cased. A malformed or placeholder host gives no links.
    No request data is involved.
  - **Content.** Summaries strip CR, LF, U+2028/2029, NEL, bidi and zero-width characters, and are at most 140
    characters.
  - **Logs.** Logs carry counts, ids and error class names only.
- **Migration 0011:** with 120 old rows (read and unread), every row is preserved, `PRAGMA foreign_key_check` is
  empty, and the FKs on the rebuilt `notifications` (user, reminder) are enforced. CHECKs reject bad reminder
  shapes (offset out of range, personal with a target, `done_at` without an outcome), bad event visibility and
  recurrence, attendees of a missing event, and a non-boolean e-mail preference. The engineer's test covers index
  preservation.
- **Time off and milestones:**
  - **Time off.** The same query and privacy as RB-06's calendar: names and am/pm only, approved requests only, no
    type, reason or id. The engineer's payload scan (`calendar-routes.test.ts`) was re-read. Deleted employees are
    hidden.
  - **Milestones.** Milestones and tasks of archived or deleted projects are hidden (`p.status = 'active' AND
    p.deleted_at IS NULL`).
- **Web basics:**
  - **CSRF.** All 11 RB-09 form actions refuse a cross-site POST and an `Origin: null` POST in the hook, before any
    route code runs.
  - **Caching.** `/calendar`, the event pages, `/reminders` and `__data.json` are `private, no-store`.
  - **Deactivated users.** A deactivated user's session never reaches the route.
  - **E-mail toggle.** The toggle answers 404 while no sender is configured. It writes only the caller's row and
    ignores a posted `user_id`.
  - **XSS.** The event description goes through the shared Markdown renderer. Title, location and summaries are
    Svelte text. There is no new `{@html}`. The engineer's `rb09-xss.test.ts` covers the checklist's XSS vectors.
- **Deploy script:**
  - **Configs.** Both configs render from `.deploy.env` with the same D1 id. A jobs config with a different id, with
    placeholders left, or without a D1 binding is refused.
  - **Values.** A sender address that tries to break out of the JSON string or uses a placeholder is refused. Problem
    messages name variables, never values. The script's own log lines carry paths only.
  - **Step order.** Migrations run, then the jobs Worker deploys, then the app. `--dry-run` runs no remote step.
  - **Dry run.** `node scripts/deploy.ts --dry-run` on this tip exited 0, and both bundles built.

## Checklist notes

- 100-parameter limit: every id list uses `json_each`.
- Bounded work: every query has a LIMIT, apart from the L2 growth noted above.
- Concurrency: caps and claims are guarded statements, proven with 20 concurrent requests.
- Soft delete: tombstones are filtered in every source and in dispatch.
- Plain-text rendering: holds.
- Logs: no titles, summaries or e-mail addresses.
- Migration: a new file, with a bookmark step kept in the deploy.

## Commands run

- `npx vitest run test/security/rb09-pure.test.ts`: 16 passed.
- `npx vitest run test/security/rb09-d1.test.ts`: 15 passed.
- `npx vitest run test/security/rb09-jobs-d1.test.ts`: 11 passed.
- `node scripts/deploy.ts --dry-run` (with a copied `.deploy.env`): exit 0, "dry run finished; nothing was uploaded".
- `npm test`: exit 0, "Tests 1637 passed (1637)".
