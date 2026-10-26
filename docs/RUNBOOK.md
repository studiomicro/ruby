# RUBY — Runbook

Ruby runs as two Cloudflare Workers in the deployer's Cloudflare account: the app Worker `ruby` on a custom domain and, since RB-09, the jobs Worker `ruby-jobs` (no URL; a Cron Trigger once a minute delivers reminders). Both bind the same D1 database `ruby`. There is one environment
(production) and no staging. Run Wrangler commands from the repo root after `npx wrangler login`. The repository is
public, so no real id or hostname is committed: see "Deployment values" below. New installation? Start with
`docs/SELF_HOSTING.md`.

## Deployment values

`wrangler.jsonc` and `workers/jobs/wrangler.jsonc` hold zero placeholders (account id, D1 `database_id`, `ruby.example.invalid` host, Access team
domain and AUD, `ACCESS_DISABLED` = `""`). The real values come from the environment or the gitignored `.deploy.env`
(copy `.deploy.env.example`, `chmod 600`; the environment wins). On macOS the file can instead live encrypted in the
Keychain: `security add-generic-password -U -a ruby -s ruby-deploy-env -w "$(base64 < .deploy.env | tr -d '\n')"`, then
delete `.deploy.env`; `npm run deploy` reads the Keychain item when the file is absent (`RUBY_KEYCHAIN_SERVICE`
overrides the service name). To edit a value, decode it with
`security find-generic-password -s ruby-deploy-env -w | base64 -d > .deploy.env`, change it, store it again and delete the
file:

| Variable                  | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`   | account id (32 hex)                                                     |
| `RUBY_D1_DATABASE_ID`     | id printed by `wrangler d1 create ruby`                                 |
| `RUBY_APP_HOST`           | custom domain of the Worker                                             |
| `RUBY_ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` (required unless Access is disabled)      |
| `RUBY_ACCESS_AUD`         | Access application AUD tag (required unless Access is disabled)         |
| `RUBY_ACCESS_DISABLED`    | empty = Access required (default); `1` = no Access application in front |
| `RUBY_REMINDER_EMAIL_FROM` | optional: verified Email Sending sender for reminder e-mail (RB-09)     |

`npm run deploy` checks the shape of every value, renders `wrangler.deploy.generated.jsonc` (gitignored, removed on
exit and on SIGINT/SIGTERM) and uses it for migrations, Time Travel and `wrangler deploy`. It refuses on a missing
value, a leftover placeholder, a dirty git tree or a version mismatch, and never prints a value.
`node scripts/deploy.ts --dry-run` runs everything except the remote steps. `node scripts/deploy.ts --write-config`
only writes the generated file and keeps it, for hand-run commands (`npx wrangler secret put HR_DATA_KEY -c
wrangler.deploy.generated.jsonc`, `wrangler rollback`, Time Travel restore); delete it afterwards. Both configs are
listed in `CONFIGS` in `scripts/deploy.ts`; the jobs config is rendered to
`workers/jobs/wrangler.deploy.generated.jsonc`, and must carry the app's D1 id and `APP_VERSION`.

## 1. Create the database

```
npx wrangler d1 create ruby
```

Put the printed `database_id` in `RUBY_D1_DATABASE_ID` in `.deploy.env`. Nothing is committed.

## 2. Create the file bucket

```
npx wrangler r2 bucket create ruby-files
```

The `r2_buckets` entry in `wrangler.jsonc` binds it as `FILES`. Keep the bucket private: no public access, no custom
domain on the bucket.

## 3. Regenerate binding types

```
npm run types:cf
```

This only needs a rerun after `wrangler.jsonc` binding changes. The generated file types vars as plain `string`.

## 4. Cloudflare Access (Zero Trust dashboard; optional)

1. Open Zero Trust → Access → Applications → Add an application → Self-hosted.
2. Name it `Ruby`. Add the public hostname of the app (`RUBY_APP_HOST`, no path, so the whole host is protected).
3. Add a policy with action Allow. Include either the specific e-mail addresses of the team or the e-mail domain.
   Add no Bypass or Everyone rule.
4. Save the application. Open it again and copy the **Application Audience (AUD) tag**.
5. Find the team domain under Zero Trust → Settings → Custom Pages (it looks like `<team>.cloudflareaccess.com`).
6. Put both in `.deploy.env` (`RUBY_ACCESS_AUD`, `RUBY_ACCESS_TEAM_DOMAIN`), leave `RUBY_ACCESS_DISABLED` empty and
   redeploy.
7. Check: an anonymous `curl -i https://<app host>/` redirects to the Access login. With the variables empty on a
   deployed host the app answers 503 ("Cloudflare Access is not configured for this deployment.") by design; with the
   vars set, a request without a valid Access JWT gets 403.

Access is the first gate. The app still requires its own invite-only account on top of it. A deployment without an
Access application sets `RUBY_ACCESS_DISABLED=1`.

## 5. First deploy

1. Run `npm run gates`; all four steps must pass.
2. Run `node scripts/deploy.ts --dry-run`, then `npm run deploy`. It records a D1 Time Travel bookmark (note it,
   outside the repository), applies remote migrations, builds, and runs `wrangler deploy`. It stops at the first
   failure. The route `RUBY_APP_HOST` is attached as a custom domain by the deploy.

## 6. First admin

While the user table is empty, open `https://<app host>/setup` (after passing Access) and create the first
account. It becomes the admin. `/setup` answers 404 once any user exists. Then use `/admin/users` to invite the
team; copy each invite link to the person.

## Routine deploy

After the gates pass, run `npm run deploy`. Keep the printed bookmark and version id with the owner's private notes;
do not commit them (the repository is public).

In order it records the D1 Time Travel bookmark, applies remote migrations, builds, deploys the jobs Worker (its
rendered `workers/jobs/wrangler.deploy.generated.jsonc`) and then the app Worker; it stops at the first failure, so a
failed jobs deploy never ships the app. `node scripts/deploy.ts --dry-run` builds and dry-runs both Workers without
touching anything remote.

Migration `0011_calendar_reminders.sql` (RB-09) rebuilds the `notifications` table to widen its CHECKs. It copies every
row and recreates the index in the same migration (verified by `test/integration/migration-0011.test.ts` and a
`wrangler d1 migrations apply --local` run over seeded notifications); nothing is dropped from the data, so it is not
a destructive migration. The bookmark printed before it is the rollback point.

## Rollback

Code: list recent versions and roll back each Worker that changed (the jobs Worker with its own config).

```
npm run deploy -- --write-config
npx wrangler deployments list -c wrangler.deploy.generated.jsonc
npx wrangler rollback [version-id] -c wrangler.deploy.generated.jsonc
npx wrangler deployments list -c workers/jobs/wrangler.deploy.generated.jsonc
npx wrangler rollback [version-id] -c workers/jobs/wrangler.deploy.generated.jsonc
```

The app works without the jobs Worker (reminders wait, and close as missed after 24 h), and the jobs Worker works
with the pre-RB-09 app once migration 0011 is applied, so the two can be rolled back independently.

Rolling back code does not undo migrations. If a migration or data change was the problem, restore D1 to the
bookmark that `npm run deploy` printed before that deploy:

```
npx wrangler d1 time-travel info ruby -c wrangler.deploy.generated.jsonc
npx wrangler d1 time-travel restore ruby -c wrangler.deploy.generated.jsonc --bookmark=<bookmark>
```

Time Travel restores the whole database to that point, so changes made after it are lost. Redeploy the matching code
version first (or restore in the same sitting), because the code and schema must agree. Objects in `ruby-files` are
not covered by Time Travel; files uploaded after the bookmark stay in the bucket without a database row until
cleaned up by hand (see Attachment orphans).

## Attachment orphans (RB-04)

An upload writes the R2 object first and the `attachments` row second. When the row cannot be written the app
deletes the object again; if that delete fails too, the log has an `attachment_orphan_candidate` line with the
object's key (`att/<uuid>`). A failed delete after a tombstone logs `attachment_r2_delete_failed` with the key; a
repeat Delete of the same file by its uploader or an admin retries it. Both kinds of object are unreachable (no
download serves them) and only cost storage. To sweep them by hand, on the trusted machine:

1. List the keys in the bucket: dashboard → R2 → `ruby-files` → Objects, prefix `att/` (wrangler 4 has no object
   list command).
2. List the keys with a live row:
   `npx wrangler d1 execute ruby -c wrangler.deploy.generated.jsonc --remote --command "SELECT r2_key FROM attachments WHERE deleted_at IS NULL"`
   (read only).
3. Delete each bucket key that is not in step 2 and is older than a day (so an upload in flight is never hit):
   `npx wrangler r2 object delete ruby-files/<key> --remote -c wrangler.deploy.generated.jsonc`.

Only the owner runs this; it changes production data.

A file larger than 5 MiB is streamed to R2 as a multipart upload. A refused or failed upload is aborted, so it
leaves no object. An upload cut off by a crashed request may leave an incomplete multipart upload, which is not an
object and is not listed. Check that the bucket's object lifecycle rules (dashboard → R2 → `ruby-files` →
Settings) abort incomplete multipart uploads after a few days.

## Attachment retention (RB-04)

Files on a deleted task or page, or in a deleted project, cannot be downloaded, and they come back if the item is
restored. Once the item (or its project) has been deleted for 30 days or more, an admin purges them: sign in as an
admin, open `/admin/attachments`, tick the confirmation and press **Purge files**. Each press tombstones up to 100
rows in one guarded statement (the 30-day rule is checked again at write time, so a restore meanwhile is respected)
and then deletes their R2 objects. The page says when more are left; press again. If R2 refuses a delete, the page
says so and the log has `attachment_purge_r2_delete_failed` with a count. The rows are already tombstoned, and the
orphan sweep above removes the objects. There is no undo. Run it monthly.

## Jobs Worker and reminders (RB-09)

`ruby-jobs` (`workers/jobs/`) has no route, no workers.dev address and no HTTP surface (its fetch answers 404). Every
minute it claims due reminders in bounded rounds (3 × 50, a 20 s budget), writes one notification per reminder and
occurrence, and writes the heartbeat `app_meta.jobs_last_run`; `/reminders` warns when that is older than 10 minutes.
At 03:15 team time it purges reminders closed or deleted more than 90 days ago (500 per run). A sent reminder's
notification stays: its link to the reminder is cleared in the same batch. Logs are counts only (`jobs_run`), plus `reminder_dispatch_failed` / `reminder_email_failed`
with a reminder id and an error class, never text or addresses.

**Owner steps, once, before the first RB-09 deploy:**

1. Confirm the account's plan covers a once-a-minute Cron Trigger and the extra D1 reads (Workers Paid; check
   Cloudflare's current Cron Triggers and D1 limits pages, not a remembered number).
2. Confirm the Worker name `ruby-jobs` is free in the account.
3. After `npm run deploy`, check the cron: dashboard → Workers & Pages → `ruby-jobs` → Settings → Triggers lists
   `* * * * *`; within two minutes `/reminders` no longer shows "the scheduler has not run". Note it in the deploy log.

**Local cron simulation.** `npm run jobs:dev` runs the jobs Worker against the local D1 in `.wrangler/state` with
`--test-scheduled`; then `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` runs one tick now. To simulate a
later minute, `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*&time=<UTC ms>"` (wrangler's
`/__scheduled` ignores `time`). A due reminder appears at `/notifications` in `npm run dev`.

## E-mail reminders (RB-09, owner answer O5)

Reminders always arrive in-app. E-mail is an extra, opt-in per user on `/account`, and stays off until the owner sets
a sender:

1. Dashboard → Email → Email Sending: onboard the sending domain (your own, for example `your-domain.example`) and
   add the DNS records it asks for; wait until the domain shows as verified.
2. Choose the sender address (for example `ruby@your-domain.example`).
3. Set `RUBY_REMINDER_EMAIL_FROM` to that address in `.deploy.env` (or the environment) and run `npm run deploy`. The
   renderer writes it into `REMINDER_EMAIL_FROM` of both configs: the app's (shows the switch on `/account`) and the
   jobs Worker's (sends). Nothing is committed.
4. Check: turn e-mail reminders on at `/account`, add a personal reminder two minutes ahead, and receive it.

To switch e-mail off again, clear `RUBY_REMINDER_EMAIL_FROM` and deploy; in-app delivery is unaffected. A failed send
(for example `E_SENDER_NOT_VERIFIED`) is logged as `reminder_email_failed` and never repeated or allowed to block the
notification. While `RUBY_REMINDER_EMAIL_FROM` is set, the renderer writes the jobs Worker's `send_email` binding as
`allowed_sender_addresses: [<that address>]`, and the deploy refuses a rendered config whose binding is not restricted
that way; the binding stays unrestricted only while e-mail is off (nothing sends then).

**Deploy logs show values.** Wrangler prints each Worker's bindings table during `npm run deploy` and `--dry-run`,
with var values: the app host, the Access team domain, part of the Access AUD and the reminder sender. Wrangler
offers no switch to hide it. Treat deploy output as private: do not paste it into issues, chats or CI logs that
others can read.

## Calendar events of deactivated users (RB-09)

Each user may hold 500 live events and create 100 a day; each user may create 300 reminders a day (deleted ones
count). A deactivated user's private events disappear from every calendar and stop counting at once. To remove all
live events a deactivated user left behind (team and private), sign in as an admin, open `/admin/events` (linked from
`/admin/users`), tick the confirmation and press **Purge events**. The page shows only a count per user, never a
title, so private events stay private; each purge writes a `calendar_events_purge` row with the count to the audit log
(`/hr/audit`). Events are soft-deleted; there is no restore screen.

The iCal feed (PRD section 5) is off (owner answer O4) and not built.

## Local development

```
npm install
npm run db:reset:local   # fresh local D1 with all migrations
npm run db:seed:local    # fictional sample data, local only
npm run dev
```

Never run seed or reset commands against the remote database.

## HR data key (RB-05)

Tier 2 and tier 3 employee data (NIK, NPWP, BPJS numbers, bank account, home address, personal contacts, emergency
contacts, salary) is encrypted in the Worker with AES-256-GCM under the secret `HR_DATA_KEY`. Without it, or with a
malformed value, those fields are read-only and the app shows "Sensitive data storage is not configured"; nothing
sensitive is stored in plain text.

**Owner step, once, before HR enters sensitive data:**

1. Generate 32 random bytes, base64url-encoded, on a trusted machine:
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`
2. Store the value in the company password manager first (there is no recovery).
3. `npx wrangler secret put HR_DATA_KEY -c wrangler.deploy.generated.jsonc` (after `npm run deploy -- --write-config`; delete the generated file afterwards) and paste the value. The Worker picks it up without a redeploy.
4. Check: open any profile as HR; the "not configured" banner is gone.

**First HR user.** Sign in as the owner's admin account, open `/admin/users`, choose "Grant HR" on your own row. The
grant is written to the HR audit log (`/hr/audit`). Only admins can grant or revoke HR access.

**Lost key.** Ciphertexts cannot be decrypted without it. Set a new key as above; every stored tier 2/3 value is then
unreadable (reveal answers "cannot be read with the current key") and HR re-enters them. Tier 0 and tier 1 data are
not encrypted and are unaffected.

**Rotation.** Not built yet: every row carries `key_version` (1). Until rotation tooling exists, do not replace a
working key; a replaced key behaves like a lost key.

**Breach procedure (personal data, UU 27/2022 PDP).** If the key, a D1 export or a Time Travel copy may have leaked:
(1) note the time and what leaked; (2) rotate the key only together with HR re-entering the data (see above), and
revoke HR access (`/admin/users`) of any account involved; (3) read `/hr/audit` for reveals and exports in the period;
(4) the owner notifies affected employees and the authority within the PDP Law's deadline (confirm the window with
counsel); (5) record the incident and actions privately (not in this public repository).

**Local and tests.** `npm run test:e2e` starts its local server with a throwaway generated key; Vitest generates its
own. For `npm run dev`, put `HR_DATA_KEY=<value>` in `.dev.vars` (gitignored). Never reuse the production key locally.

