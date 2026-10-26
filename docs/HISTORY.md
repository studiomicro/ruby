# RUBY — History

Completed work and the test evidence log, kept as written at the time; entries describe the state on their date.
Open work: `docs/TASKS.md`. What is verified and how: `docs/ACCEPTANCE.md`.

## Completed work

- **RB-09 Calendar and reminders (2026-10-26, v0.4.0)** — `/calendar` month/week/agenda (agenda default on phones) aggregating task due dates, milestones, approved time off (names and day parts only) and holidays, plus first-class events (team or private, attendees, simple recurrence with limits); reminders on tasks, events and personal, delivered in-app by the new `ruby-jobs` Worker (1-minute Cron, idempotent claiming, backoff and dead-letter, 24 h late window) and by e-mail once `REMINDER_EMAIL_FROM` is set; per-user caps (500 live events, 100 events/day, 300 reminders/day). Migration 0011 (rebuilds `notifications`). QA PASS; red team PASS; 5 Low fixed in cycle 2. NOT verified: the real Cloudflare cron and Email Sending before this deploy.

- **RB-06 Time off (2026-10-26, v0.3.0)** — leave types, requests counted in working days (weekends and HR-entered holidays skipped, half days), UU-default annual leave (12 days, prorated in year 1, no carry-over), approval by manager else HR/admin, audited self-approval only while no manager, other active HR user or other active admin exists, append-only leave ledger with read-only balances on GET, team calendar (names and day parts only), HR settings and holidays, terminate/delete cancels pending requests. Migration 0003_time_off (snapshot file 0011_snapshot.json because drizzle-kit chains by file name). QA PASS (2 Medium fixed); red team PASS (6 Low fixed), re-check PASS, N1 fixed in cycle 3. NOT verified: production holidays (owner enters them).

- **RB-10 Kumo design (2026-10-26)** — owner request "implement design from kumo-ui.com": Kumo (MIT, cloudflare/kumo @ 947065a) token values ported into `src/app.css` with attribution in `THIRD_PARTY_NOTICES.md`, darkened where Kumo fails WCAG AA; Svelte kit re-created (no React): restyled Button/Badge/Banner/EmptyState/PageHeader/FieldError/TextField/TextArea/Select, new Card, Table, Tabs, Dialog, DropdownMenu, Toaster, Checkbox, Switch; shell and auth restyled; Select keeps a choice made before hydration; `.sr-only` board overflow bug fixed; stricter overflow helper. Contrast test over token pairs. Screenshots in `docs/design/screenshots/`. NOT verified: on real iOS devices.

- **RB-11 Release notes and reload (2026-10-26)** — `/releases` What's new page from Markdown files in `src/lib/content/releases/` (rendered via `renderMarkdown`), a New dot (localStorage), an update banner (SvelteKit `updated`, 60 s poll) with Reload, a confirm before Reload or a link discards unsaved input, full-page load on the next navigation after an update, `/_app/version.json` no-store, version 0.2.0 kept in step across package.json, APP_VERSION and the newest notes (Vitest + deploy refusal). QA+security review: FAIL (banner covered the More sheet) then fixed by the orchestrator with e2e. NOT verified: deployed Cache-Control on version.json.

- **RB-08 Project management extras (2026-10-26)** — labels (10 per task, 30 per project), task checklists (50 steps), milestones with progress pages, advisory WIP limits, per-project rename/hide of the six board columns, saved views, bulk edit (100 tasks, all-or-nothing, at most 10 assignment notifications per bulk). Manager-only writes guarded in SQL. Migration 0010_pm_plus (additive; FTS triggers intact). QA PASS; red team PASS (3 Low fixed in cycle 2). NOT verified: dark-mode chip colours by eye.

- **RB-05 Employee directory (2026-10-26)** — `/people` directory and profiles, org chart, `users.is_hr` grant (admin, audited; cleared on account disable), three data tiers with AES-256-GCM encrypted NIK/NPWP/BPJS/bank and salary history (`employee_compensation`, HR only, append-only), audited reveal, `/hr/audit`, CSV export (POST, formula-safe), manager-cycle guards incl. restore. Migration 0002_hr_core (immutable audit/salary rows via triggers). QA PASS; red team PASS (3 Low fixed in cycle 2). NOT verified: on production until `HR_DATA_KEY` is set (sensitive fields fail closed).

- **RB-04 Attachments (2026-10-26)** — upload to tasks and pages (25 MB, 20 per target, one per request) streamed to R2 by a hand-written multipart reader (≤ one 5 MiB part in memory; R2 multipart above that), guarded insert (cap, live target, active uploader), authorised downloads (`attachment` except byte-checked PNG/JPEG/GIF/WebP; nosniff; `sandbox; default-src 'none'; frame-ancestors 'none'`; XFO DENY; `private, no-store`), soft delete then R2 delete, admin purge `/admin/attachments` for files of parents deleted 30+ days. No migration. QA PASS; red team PASS (5 Low fixed in cycle 2, re-check PASS; N1/R1 Low follow-ups open). NOT verified: large uploads on the deployed Worker.

- **RB-03 Comments, @mentions and notifications (2026-10-26)** — comments on tasks and pages (edit own, delete own or admin, optimistic edits), @mention picker (`/api/mentions`, 60/min), notifications for mentions, comments on your tasks and assignments, `/notifications` with mark read and the unread badge; mentions render real names, deactivated users marked. Shell: phones keep focused controls above the tab bar (`scroll-padding`). No migration. QA PASS (F1 tab bar fixed); red team FAIL (M1 excerpts of deleted targets) then PASS after cycle 2. NOT verified: behaviour with real team volume.

- **RB-01 Projects and tasks (2026-10-26)** — projects (key, lead, archive freezes tasks), tasks with per-project numbers (`OPS-12`), status/priority/assignee/due date (`TEAM_TIME_ZONE` Asia/Jakarta), list view with filters, board with drag, keyboard and no-JS moves, task detail with optimistic-concurrency edits, My tasks, `assigned` notifications (deduplicated while unread). No migration. QA PASS (tap-target and key-input Lows fixed); red team PASS (4 Lows: mention names, notification spam, archived renumber fixed; FTS tombstones covered by search). NOT verified: touch drag on a real phone.

- **RB-02 Knowledge base (2026-10-26)** — team-wide and per-project page trees (depth 8), Markdown editor with preview, revisions with optimistic concurrency, conflict view, history and restore, move, subtree soft delete (members only when every page in the subtree is theirs; admins any), `/search` over `pages_fts` and `tasks_fts` with safe MATCH building, escaped snippets, 30/min and 300/10 min per user. No migration. QA PASS (2 Low, fixed); red team FAIL (M1 subtree delete via move + 4 Low) then PASS after cycle 2; L4 render cost accepted. Added `overUserMinuteLimit` to throttle.ts. NOT verified: behaviour on remote D1 with real data volume.

- **RB-00 Foundation (2026-10-26)** — invite-only accounts (first-admin `/setup`, one-use invites, user admin with a last-admin guard and unlock), PBKDF2 sign-in with lockout, hashed sessions, fail-closed throttles, Cloudflare Access JWT verification (RS256, JWKS single flight with failure back-off), CSRF/CSP/security headers, safe Markdown with mention names, responsive shell with iPhone safe-area layout, deploy script. Migrations 0000_init, 0001_search. Red team: FAIL (1 Medium, 9 Low) then PASS after cycle 1; L4 (sign-in timing) and L7 (Access e-mail vs account e-mail) accepted. NOT verified: a real Access-authenticated request reaching the app (owner sign-in still blocked by the Access policy).

- **Project start (2026-10-26)** — owner decisions recorded in `CLAUDE.md`; multi-agent pipeline and docs set up. No feature code yet.

## Test evidence log

- 2026-10-26 RB-09 (load ~2): `COMPLETED 1210 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 82 passed (82)`, `Tests 1656 passed (1656)`; e2e `283 passed`, `46 skipped`; deploy dry-run exit 0 (jobs then app).

- 2026-10-26 RB-06 squashed on main with v0.3.0 notes: `COMPLETED 1139 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 66 passed (66)`, `Tests 1500 passed (1500)`. e2e (engineer, port 4431): `258 passed, 43 skipped`.

- 2026-10-26 RB-10 rebased on RB-08/RB-11: `COMPLETED 1094 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 58 passed (58)`, `Tests 1333 passed (1333)`; full e2e (port 4451, CI=1) `224 passed`, `37 skipped`.

- 2026-10-26 RB-11 squashed on main: `COMPLETED 1080 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 56 passed (56)`, `Tests 1219 passed (1219)`. e2e releases + rb11-qa + shell (port 4481): `59 passed`, `2 skipped`.

- 2026-10-26 RB-08 squashed on main: `COMPLETED 1069 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 54 passed (54)`, `Tests 1201 passed (1201)`. e2e (engineer, port 4411): `176 passed, 29 skipped` (second run; first run hit the kit Select hydration flake, fix pending in RB-10).

- 2026-10-26 RB-05 squashed on main: `COMPLETED 1037 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 51 passed (51)`, `Tests 1114 passed (1114)`. e2e (engineer, port 4401, twice): `158 passed, 23 skipped`.

- 2026-10-26 RB-04 squashed on main (with RB-03): `COMPLETED 990 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 46 passed (46)`, `Tests 1031 passed (1031)` (two load-sensitive tests hardened: pinned clock in the mention-throttle test, 120 s timeout on the 400-drop board test). e2e (engineer, port 4371): `104 passed, 17 skipped`.

- 2026-10-26 RB-03 squashed on main: `COMPLETED 958 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 40 passed (40)`, `Tests 809 passed (809)`. e2e (engineer, port 4361): `109 passed, 20 skipped`.

- 2026-10-26 RB-01 rebased on RB-02: `COMPLETED 928 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 33 passed (33)`, `Tests 688 passed (688)`; combined e2e `83 passed`, `14 skipped`.

- 2026-10-26 RB-02 squashed on main: `COMPLETED 866 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 27 passed (27)`, `Tests 575 passed (575)`. e2e (engineer, port 4322): `43 passed, 2 skipped`.

- 2026-10-26 RB-00 on main: `COMPLETED 801 FILES 0 ERRORS 0 WARNINGS`; Prettier clean; `Test Files 17 passed (17)`, `Tests 369 passed (369)`; build `✔ done`. e2e (foundation engineer): `19 passed`, `2 skipped`.

One bullet per run: date, command, exit code, decisive output line, real or mocked.
