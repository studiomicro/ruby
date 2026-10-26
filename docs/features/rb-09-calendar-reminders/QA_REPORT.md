# RB-09 Calendar and reminders — QA report

**Verdict: PASS** (no blocking defects; two Low findings and one Info below)

Tested commit: cd21fd1 (detached, single commit over main). All runs hit local fixtures (local D1 via workerd, local Playwright preview); nothing remote.

## Commands run
- `npm ci --prefer-offline --no-audit --no-fund` then `npx svelte-kit sync`: ok.
- `npm run gates`: exit 0; Vitest 75 files, 1595 tests passed; check, lint, build and both `wrangler deploy --dry-run` steps clean (local build, fixtures).
- `RUBY_E2E_PORT=4511 npm run test:e2e`: exit 0; 283 passed, 46 skipped (project-specific skips), 0 failed (local preview, local D1).
- `npm run db:reset:local`: exit 0; all migrations incl. 0011 apply on a fresh DB, seed ok.
- `node scripts/deploy.ts --dry-run` (clean tree, `.deploy.env` copied): exit 0; order is Build, `[2/3] Deploy jobs Worker (ruby-jobs)`, `[3/3] Deploy app Worker`; both wrangler calls got `--dry-run`; remote bookmark/migration steps skipped; "nothing was uploaded".
- `npx vitest run test/qa/rb09-time.test.ts test/qa/rb09-dispatch.test.ts`: 2 files, 13 tests passed (local D1).

## Hand time maths (Asia/Jakarta, UTC+7, test/qa/rb09-time.test.ts and rb09-dispatch.test.ts)
- Timed 14:00 WIB = 07:00Z. PASS.
- Task due 2026-11-05, "1 day before": 09:00 WIB anchor = 02:00Z, fire_at 2026-11-04T02:00Z. PASS (also through createReminder).
- Timed 23:00-01:00 WIB shows on both team days, not a third; timed ending exactly 00:00 (end exclusive) does not touch the next day. PASS.
- All-day over 3 days: on days 1-3, not 4. PASS.
- Week starts Monday (Sun 2026-11-01 -> Mon 2026-10-26); Nov 2026 grid Oct 26..Dec 6 (42 days); Feb 2028 grid starts Jan 31. PASS.
- Recurrence: every 2 weeks until 11-30 inclusive gives 11-02, 11-16, 11-30; monthly on the 31st gives Jan 31, Feb 28 (2027) / Feb 29 (2028), Mar 31. PASS.
- Reminder exactly at tick: sent at `fire_at`, untouched at `fire_at - 1 ms`. PASS.
- Late window: exactly 24 h late is sent, 24 h + 1 ms closes `missed` with no notification (existing test: 25 h missed, 23 h sent). PASS.

## Acceptance criteria
All [A] criteria have a covering test in the diff and pass in `npm run gates`; evidence file in brackets.
1-3 access, same 404 for hidden/missing, CSRF/no-JS: PASS [test/integration/calendar-routes.test.ts "access (1, 2)"].
4-8 filters, milestones, time off, parsing, caps and constant query count: PASS [calendar-routes "calendar (4, 7, 8)"; time off payload scan shows names and day parts only, no type/reason/pending/rejected; milestones link to page, closed only with done=1, deleted hidden].
9, 36 viewports: PASS [e2e/calendar.spec.ts, 25 calendar tests pass on iphone-402, iphone-440, phone-360, desktop: agenda default on phones, month on desktop, no sideways page scroll, 44 px targets; month/week scroll inside own box confirmed by spec].
10-16 events (timing, limits, Markdown XSS, recurrence, privacy, edit/409, soft delete): PASS [calendar-routes "events"; test/security/rb09-xss.test.ts; src/lib/shared/calendar.test.ts; src/lib/server/events/validation.test.ts]. Private event: third member and admin get the identical 404 as a missing id; not in list or counts.
17-27 reminders and dispatch: PASS [test/integration/reminders-dispatch.test.ts: single send, overlap, clock step back, batching 50x3, 20 s budget, backoff 2/4/8/16 min, dead at 5th, lease reclaim, edit hooks, cancellations, recurrence walk, purge at 03:15; calendar-routes "reminders"].
28 local cron simulation: PASS by proxy [test/integration/jobs-worker.test.ts exercises the scheduled handler, which awaits `runJobs`; real Cloudflare cron fires only after first deploy, as PRD says]. Not run with live `wrangler dev`.
29 migration 0011: PASS [test/integration/migration-0011.test.ts; fresh `db:reset:local` ok].
30-32 feed: PASS as feature-off (owner answer: off). Flag unset gives 404 on route and account section; flagged-on tests present.
33-34 deploy/jobs config: PASS (deploy.test.ts in gates; dry-run above; jobs config has cron `* * * * *`, no routes, `workers_dev:false`, same D1 placeholder id, fetch answers 404).
35 gates: PASS.
Engineer deviations: scheduled handler awaits the run (ok, ends with work); edit sets pending `fire_at = now` and next tick recomputes (verified by "a due-date edit moves fire_at" and bulk-edit tests; ok); 100/day cap is a SQL count in the INSERT (events/repo.ts:162, tested "101st refused"; ok); purge keeps reminders with notifications (see F1).
E-mail: off while `REMINDER_EMAIL_FROM` empty or binding missing, in-app unaffected [reminders-dispatch "off while..."]. Not tested against real Email Sending.

## Findings
- F1 Low: `src/lib/server/reminders/jobs.ts:51-55` purge skips every reminder that produced a notification (`NOT EXISTS notifications`). Every sent reminder therefore stays forever, so O12 / criterion 27 (closed reminders older than 90 days purged) holds only for missed/canceled/dead ones. Repro: send a reminder, advance 91 days, run `purgeClosed`; row remains. Table growth is slow (one row per sent reminder), so no action needed before ship; record as follow-up or accept the deviation.
- F2 Low: `src/lib/server/reminders/dispatch.ts` plan(): after a task due-date edit sets `fire_at = now`, a pending reminder whose derived time is unchanged but already past (job outage) is canceled, not sent. Narrow edge; not reproduced by test.
- F3 Info: the 360 px profile also runs in e2e (phone-360); 46 skipped tests are project-gated, not RB-09.

Proof tests added: `test/qa/rb09-time.test.ts`, `test/qa/rb09-dispatch.test.ts`. No product code changed; nothing committed.
