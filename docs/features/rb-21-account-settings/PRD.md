# RB-21 Account settings

> A `/settings` hub where every signed-in person manages their profile, password, passkeys, devices, theme, notifications, data export and account deletion.

## Summary

| Field | Value |
| --- | --- |
| ID | RB-21 |
| Status | Draft (owner decisions pending) |
| Risk tier | Large (new sign-in path with WebAuthn passkeys, session metadata and revocation, account deletion that anonymises authored content across ~36 user foreign keys, a personal data export, re-authentication on sensitive actions; engineer + QA + red team) |
| Release version | 0.7.0 (release note `src/lib/content/releases/0.7.0.md`) |
| Migration | `0013_user_settings.sql`, `0014_passkeys_sessions_events.sql`; `0015_avatars.sql` only if the owner approves avatar upload (O2) |
| Depends on | RB-00 (hard: auth, sessions, throttle, Access), RB-03 (hard: notifications), RB-09 (hard: reminder e-mail pref, calendar), RB-10 (hard: design kit and tokens; live), RB-11 (hard: `/releases`); soft: RB-05 (job title in Profile when the user is linked to an employee), RB-06 (time off in the export), RB-20 (Install guidance; in build: the Install row links to whatever route RB-20 merges as and is hidden until it exists) |
| Owner | Owner (request 2026-10-26: add account settings, in the grouped-row style of a modern settings area) |
| Date | 2026-10-26 |

## Contents

1. [Goal and user value](#1-goal-and-user-value)
2. [Scope](#2-scope)
3. [Current behaviour this builds on](#3-current-behaviour-this-builds-on)
4. [Design](#4-design)
5. [Routes and UI](#5-routes-and-ui)
6. [Data and migrations](#6-data-and-migrations)
7. [Limits](#7-limits)
8. [Authorization](#8-authorization)
9. [Concurrency and failure states](#9-concurrency-and-failure-states)
10. [Mobile and accessibility](#10-mobile-and-accessibility)
11. [Security and privacy](#11-security-and-privacy)
12. [Acceptance criteria](#12-acceptance-criteria)
13. [Test plan](#13-test-plan)
14. [Owner decisions](#14-owner-decisions)
15. [Out of scope / later](#15-out-of-scope--later)
16. [Release note draft](#16-release-note-draft)

## 1. Goal and user value

Today `/account` is one page with a name field, a password form and (RB-09) one e-mail toggle. People cannot see where they are signed in, cannot sign in without typing a password, cannot choose a theme, cannot silence a kind of notification, cannot take their data with them and cannot leave. For an internal tool that holds a team's work, sessions, credentials and exit are the account's real surface.

RB-21 replaces `/account` with a `/settings` hub in a grouped-row style: Profile, Security (password, passkeys, devices, sign-in history), Appearance, Notifications, Privacy and data (export, delete), Install and About. Everything works the same with Cloudflare Access on or off.

## 2. Scope

**In**

- The `/settings` hub and its sub-routes (section 5), with `/account` redirecting to `/settings`.
- Profile: name, initials colour (8 token colours), read-only e-mail, role, job title and time zone display.
- Security: password change (moved), passkeys (WebAuthn) as a second way to sign in, active devices with remote sign-out, sign-in history, re-authentication on sensitive actions.
- Appearance: theme (System / Light / Dark) without a flash on first paint, density setting (comfortable shipped, compact disabled).
- Notifications: per-kind in-app toggles and the RB-09 e-mail reminder toggle (moved).
- Privacy and data: export my data (store-only ZIP), delete my account (anonymise in place).
- Install (link to RB-20 guidance) and About (version, What's new, licence, third-party notices).
- New kit components `GroupList` and `IconRow`, session metadata, `auth_events`, the export and delete table decision list.

**Out**

- Everything in section 15.

## 3. Current behaviour this builds on

- `/account` (`src/routes/(app)/account/+page.server.ts:19-71`): loader returns name, e-mail, role and the RB-09 toggle; actions `emailReminders`, `name` (`updateOwnName`), `password` (proof via `signInWithPassword`, throttle scope `account-password`, then `changePassword`).
- `changePassword` (`src/lib/server/auth/change-password.ts`): one `db.batch`, guarded on the proven hash, revokes every other session of the user and keeps the current one. Kept as is.
- Sessions (`src/lib/server/auth/session.ts`): opaque token, only the SHA-256 in D1, 30-day absolute life, `last_seen_at` touched at most hourly, `guardedSessionInsert` (INSERT … SELECT guarded on an active user), `resolveSession` joins `users` on every request. Table `sessions` has no device metadata today (`schema.ts:90-104`).
- Throttle (`auth/throttle.ts`): `countAttempt`, `overAttemptLimit` (per client), `overUserAttemptLimit` (per user, 10-minute window, default 20), `overUserMinuteLimit`; scopes are a typed list `THROTTLE_SCOPES` (`throttle.ts:30-43`); fail closed.
- Hooks (`src/hooks.server.ts:42-80`): CSRF check, host-based `secure`, Access JWT unless `ACCESS_DISABLED === '1'`, then `authGate`. Access and the in-app session are independent layers.
- Shell nav (`src/lib/ui/shell/nav.ts:57-61`): `ACCOUNT` = `/account`, shown in the sidebar footer and the phone More sheet. `FOOTER_ITEMS` holds What's new and Admin.
- Theme today: `app.css` follows `prefers-color-scheme` unless `<html data-theme="light|dark">` (`app.css:28,111-149`); nothing sets the attribute; `app.html` has a static `<html lang="en">`.
- `users` has 36 inbound foreign keys (tasks, comments, pages, revisions, events, notifications, HR audit …). `users.status` is CHECK `('active','disabled')`. A user row can therefore never be hard-deleted without orphaning team content; deletion is **anonymisation in place**.
- `employees.user_id` links a directory record to an account (RB-05); `employees.job_title` is a tier 0 field.
- Roadmap ids: `docs/features/rb-15-tracker-roadmap.md` renumbers Phase B "Quick actions and auto-assignment" to RB-22, so RB-21 is free for this feature.

## 4. Design

### 4.1 Profile

- **Name:** existing `updateOwnName` (1–80 characters, trimmed, `cleanText`). Optimistic concurrency not needed (last write wins, own row).
- **Avatar colour:** `avatar_color` integer 0–7 or null (null = derived from the user id, today's behaviour in `ui/kit/initials.ts`). Eight swatches (44 px targets) mapped to RB-10 tokens; selected state has a check and `aria-checked`. Shown everywhere `Avatar` renders for that user (directory, comments, assignee chips): `Avatar` takes an optional `color`; the queries that already select the user's name add `avatar_color` through the one shared user-summary select (engineer to find the shared helper; no per-feature copy).
- **Job title:** shown read-only only when an employee record is linked to this user; value from tier 0 `employees.job_title`; text "Set by HR. Ask HR to change it." Nothing from tiers 1–3 appears in settings, ever.
- **Time zone:** read-only text: "The calendar uses Asia/Jakarta (WIB)" from `TEAM_TIME_ZONE`, and "Your device is set to <Intl zone>" rendered in the browser only.
- E-mail and role are not editable here (admin-managed at `/admin/users`).

### 4.2 Change password

Moved verbatim (same action logic, same `account-password` throttle, same message strings, same revoke-other-sessions batch). Success text: "Password changed. Other devices were signed out." Writes an `auth_events` row `password_changed`.

### 4.3 Passkeys (WebAuthn)

Passkeys are built with no new dependency (O1):

- `src/lib/shared/passkeys.ts` (constants: max **10** live passkeys per account, name ≤ 40, challenge TTL 5 minutes, algorithms ES256 −7 and RS256 −257, transports whitelist), `src/lib/shared/base64url.ts`.
- `src/lib/server/auth/webauthn-verify.ts` (own verifier: CBOR subset, authData parse, COSE → WebCrypto import, clientDataJSON type/challenge/origin, signature over `authData || SHA-256(clientDataJSON)`, about 470 lines, no dependency), `passkeys.ts` (repo), `passkey-flow.ts` (options, verify, rpId). Attestation `none`; user verification `preferred` at sign-in and **`required`** for re-authentication and registration; resident key `preferred`. Test vectors from the W3C spec plus recorded Chrome and Safari fixtures.
- **rpId** is the request host for a secure deployment or `localhost`; `null` (feature hidden, "Passkeys need a permanent address") for an IP literal, `*.workers.dev` or any other loopback name. Expected origin = request origin exactly. A host change orphans passkeys: RUNBOOK gets a "Passkeys" section saying so. Cloudflare Access on: the passkey ceremony runs against the same host after Access has admitted the browser; Access off: identical. Passkeys do **not** satisfy or bypass the Access layer.
- **Sign-in** at `(auth)/login`: actions `passkeyOptions` and `passkey`; with JavaScript and `PublicKeyCredential.isConditionalMediationAvailable()`, the e-mail field gets `autocomplete="username webauthn"` and a conditional `navigator.credentials.get` starts on mount; a "Sign in with a passkey" button is the fallback and is hidden when `window.PublicKeyCredential` is undefined. Without JavaScript the password form works as today. The discoverable credential's `userHandle` must equal the credential owner's user id. A deactivated or anonymised user is refused with the same generic answer as a wrong password. Session via new `createPasskeySession` (guarded INSERT … SELECT on the passkey row still live and the user active, same `last_login_at` update); the replaced cookie's session is revoked as password sign-in does today.
- **Management** at `/settings/security/passkeys`: list (name, created, last used, "synced"/"this device only" from `backed_up`, transports; never the public key or credential id), **Add a passkey** (needs a fresh proof, 4.5), **Rename** (name only; no re-auth), **Remove** (needs fresh proof; revokes every session that passkey created except the current one). Empty state "No passkeys yet", unsupported-browser state, cap state "You have 10 passkeys. Remove one to add another.", pending/cancelled/refused/saving/success states with copy. Default name from the authenticator when given, else "Passkey <date>".
- Every sensitive action accepts either proof (password or a fresh passkey assertion, 4.5), including account deletion.

### 4.4 Devices (active sessions) and sign-in history

**Devices.** `/settings/security/devices` lists the user's live sessions (not revoked, not expired), at most 50, newest `last_seen_at` first: device label (from the stored summary), "This device" badge for the current session, signed in (`created_at`), last active (`last_seen_at`, hourly resolution, labelled "about"), sign-in method (Password / Passkey). Actions: **Sign out** one (not the current one; the current device uses the normal Sign out) and **Sign out all other devices** (needs a fresh proof). Revoke = set `revoked_at` guarded on `user_id = me AND revoked_at IS NULL`; idempotent; a foreign or unknown session id answers the same 404. Copy states that with Cloudflare Access on, signing out of Ruby does not end the Access session ("Your company sign-in with Cloudflare Access is separate").

- Metadata captured at session creation by every creator (`createPasswordSession`, `createPasskeySession`, setup, invite acceptance): `user_agent` = **summary label only** from a pure `summarizeUserAgent(header)` (fixed vocabulary: Chrome, Safari, Firefox, Edge, Samsung Internet; OS: Windows, macOS, iOS, iPadOS, Android, Linux, ChromeOS; unknown → "Unknown device"; max 60 characters). No IP, no raw header, no city.
- Sessions created before the migration show "Unknown device".

**Sign-in history.** `/settings/security/history`: newest 20 rows of the user's `auth_events` (event label, device label, time). Kinds: `sign_in_password`, `sign_in_passkey`, `sign_in_failed` (written only when the e-mail matches an existing active user, so it is a record for that user, and capped at one row per user per minute), `password_changed`, `passkey_added`, `passkey_removed`, `sessions_revoked`, `data_exported`. Rows older than 90 days, and rows beyond the newest 200 per user, are deleted opportunistically on the user's next insert (same pattern as `countAttempt`), so no job is added. Content-free: no IP, no raw user agent.

### 4.5 Re-authentication (O8)

One module `auth/reauth.ts`:

- `sessions.reauth_at` (integer, null). A successful proof sets it to now for **the current session only**, guarded `WHERE token_hash = ? AND revoked_at IS NULL`.
- Proof = the user's current password (via the existing `signInWithPassword`, throttle scope `account-password`, counts toward the account lockout) **or** a passkey assertion (challenge kind `reauth`, user verification required, credential must belong to this user).
- Actions that require `reauth_at > now − 5 min`: passkey add, passkey remove, export download, sign out all other devices. Without it the action answers 403 `reauth_required`; the UI opens a "Confirm it's you" dialog (password field with 16 px input, plus "Use a passkey" when the user has one) and retries.
- **Delete account** does not use the window: the password (or a passkey assertion) is supplied in the delete request itself.
- Rename passkey, theme, notification toggles, avatar colour, name: no re-auth.

### 4.6 Appearance (O7)

- `user_prefs.theme` in `('system','light','dark')`, `user_prefs.density` in `('comfortable','compact')` (default `system`, `comfortable`).
- **No flash:** `app.html` gets `<html lang="en" %ruby.html%>`; `hooks.server.ts` fills it in `transformPageChunk` with `data-theme="light|dark"` and `data-density="compact"` (empty for system/comfortable, so `prefers-color-scheme` still applies as today). It also swaps the two `theme-color` metas for one fixed colour when the theme is explicit. No inline script, so the CSP is unchanged.
- **Source of truth for rendering is a cookie** `ruby_theme` (`light|dark|system`) and `ruby_density`, `SameSite=Lax`, `Path=/`, one year, `Secure` on deployed hosts, **not** HttpOnly (harmless, and the sign-in page needs it before a session exists). The database row is the cross-device truth: saving writes both; `(app)/+layout.server.ts` re-writes the cookie when it differs from the row (a new device); sign-out leaves the cookie in place so `/login` keeps the theme.
- The values are validated against the whitelist before they reach `transformPageChunk`; anything else renders as system. Honoured by the RB-10 tokens in `app.css` (`:root[data-theme='dark']` already exists). `Select`-style three-option segmented control (44 px segments) with a live preview applied immediately on the client (`document.documentElement.dataset.theme`) and persisted by a form action that also works without JavaScript.
- Density: control present, "Compact" disabled with "Coming soon" under O7's default; the attribute and column exist.

### 4.7 Notifications

- `user_notification_prefs (user_id, kind, in_app)`, sparse: a row exists only for a kind the user turned **off** (absent = on). Kinds: `mention`, `assigned`, `comment`, `reminder`. Toggle rows are `Switch` rows of 44 px with a one-line hint.
- Enforced **at write time**: every insert into `notifications` for kind K and recipient U gets `… WHERE NOT EXISTS (SELECT 1 FROM user_notification_prefs WHERE user_id = U AND kind = K AND in_app = 0)` in the same statement/batch (shared helper in `notifications/repo.ts`; the RB-03 comment/mention/assign writers and the RB-09 reminder delivery use it). Muting does not hide existing rows. Muting `reminder` mutes only the in-app row; the reminder still fires and the RB-09 e-mail rule is unchanged. The jobs Worker imports the helper by relative path (no `#lib`, per CLAUDE.md).
- **Reminder e-mail toggle** (RB-09) moves here unchanged in behaviour (`setEmailReminders`, 404 while no sender is configured; the row is hidden then). `/reminders` and the calendar link to `/settings/notifications`.
- Time-off decisions are deferred (O10).

### 4.8 Export my data (O6)

`POST /settings/privacy/export/download`:

- Order: `requireUser` → CSRF (hook) → throttle `data-export` (2 per 10-minute window, per user) → fresh-proof check (4.5) → build counts → refuse over the cap → stream.
- Content, **own data only**: `README.txt` (what is inside, UTC timestamps), `profile.json` (name, e-mail, role, created, theme, density, notification toggles; never hashes, tokens or credential ids), `tasks.csv` + `tasks.json` (tasks I created or am assigned: key and number, title, description, status, priority, dates, labels; other people appear only as "someone else"), `pages.json` (pages I authored: title, body, created, updated, plus my revisions), `comments.csv` + `comments.json` (comments I wrote, with the task or page title as context; mention markup left in my own text), `time-off.csv` (my requests and my own ledger lines), `reminders.json` (mine), `events.json` (events I created or attend: title, time, my response; attendee lists omitted), `attachments.json` (metadata of files I uploaded; **bytes are not included**), `sign-in-history.json`, `notifications.json` (my notification rows, last 90 days).
- **Never** another person's data and never HR data: no employee record, no tier 1–3 values, no salary, no `hr_audit_log`, no other user's e-mail. Time off is limited to the user's own requests. A user who wants their employee record asks HR (RB-05 self-service is out of scope here).
- **Bounded:** at most **50,000 rows** across all sets (counted first in SQL; over the cap answers a page message "Your export is too large to build here. Ask an admin.", nothing streamed); each set read by keyset pages of 500 so memory stays flat; store-only ZIP (`src/lib/shared/zip.ts`) written as the response pulls; no R2 reads. No file is stored server-side.
- Response headers: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="ruby-export-YYYY-MM-DD.zip"`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. Writes `data_exported` to `auth_events` (no counts of content). Never logged beyond the request line.
- **Table decision list** (`src/lib/server/export/tables.ts`): every table with a user foreign key is listed as `export` / `exclude (reason)` / `delete on account delete` / `anonymise on account delete`, and a Vitest test introspects the Drizzle schema and **fails when a table that references `users` has no decision**. This single list drives both export and delete, so a later feature (RB-12 …) cannot silently leak into, or be left behind by, either.

### 4.9 Delete my account (O3, O4, O5)

- Page `/settings/privacy/delete` explains in plain words what is removed, what stays ("Your tasks, pages and comments stay for your team and show your name as 'Former member'."), that it cannot be undone and that HR records are handled by HR. Requires typing the account e-mail **and** the current password (or a fresh passkey assertion) in the same request; throttle `account-delete` (5 per window per user) plus the password lockout.
- Server function `deleteAccount(db, userId, proof, now)` in `auth/delete-account.ts`, **one `db.batch`** (one D1 transaction), every statement guarded on a marker so a failed proof or a lost race writes nothing. Step 1 marks `users.deleted_at = now` guarded on: proof still valid (stored hash unchanged), user active and not already deleted, **and not the last active admin** (`NOT (role = 'admin' AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id <> me AND o.role = 'admin' AND o.status = 'active' AND o.deleted_at IS NULL))`). Later steps act only on the user row marked `deleted_at = now`. Two admins deleting themselves concurrently: D1 serialises the batches, the second finds no other active admin and writes nothing.
  - Deleted outright: `user_passwords`, `sessions`, `passkeys`, `passkey_challenges`, `auth_events`, `user_prefs`, `user_notification_prefs`, `user_calendar_prefs`, `calendar_feed_tokens`, the user's `notifications` (as recipient), reminders and personal notes (RB-09, recipient = me), unaccepted invites the user created, personal saved views, event attendee rows and responses for others' events.
  - Anonymised in place on `users`: `email` → `deleted-<id>@ruby.invalid` (frees the real address for a fresh invite), `name` → `Former member`, `status` → `disabled`, `is_hr` → 0, `avatar_color` null, `last_login_at` null, `deleted_at` set. The row, its id and every authored row stay, so foreign keys hold. `role` stays (history only; a disabled user has no session).
  - Kept untouched: tasks, comments, pages, revisions, attachments (and their R2 objects), events created by the user, labels, time-off ledger entries, `hr_audit_log` rows, employee rows (kept, still linked; **O5**). One `hr_audit_log` row `account_deleted` (employee id, user id, no values) is added when an employee record is linked.
  - @mention markup `@[Name](user:<id>)` already resolves display names from `users`, so mentions of the deleted user render "Former member" without rewriting any comment body.
- After the batch: cookie cleared, `Clear-Site-Data` as sign-out does, redirect to `/login` with a neutral banner "Your account was deleted." The deleted user cannot sign in again (disabled + unknown credentials); the admin list at `/admin/users` shows deleted users in a separate collapsed "Deleted accounts" group, read-only, no reactivate button (reactivating would resurrect an anonymised row).
- Admin deactivation (`/admin/users`) is a different, reversible action and is unchanged.

### 4.10 Install and About

- **Install:** `/settings/install` shows a one-paragraph summary and a primary link to RB-20's install guidance (route name taken from RB-20 at merge); on a device where RB-20 exposes a `beforeinstallprompt` button, RB-20's component is reused, not reimplemented. Hidden when RB-20 is not merged.
- **About:** version from `APP_VERSION` (same value RB-11 checks against `package.json` and the newest release file), What's new → `/releases`, "Ruby is open source under the MIT licence" with a link to `https://github.com/studiomicro/ruby` and the licence text path in the repository, and a **Third-party notices** section generated at build time from `package.json` runtime dependencies (name, version, licence) into a static `src/lib/content/third-party.ts` by a script run in `npm run build`'s prebuild step; a Vitest test fails if a runtime dependency has no licence entry. Fonts: Geist (SIL OFL 1.1) is listed with its licence text.

### 4.11 Modules and reuse

**New or changed modules**

- `src/lib/shared/`: `passkeys.ts`, `base64url.ts`, `zip.ts`, `user-agent.ts` (pure `summarizeUserAgent`), `theme.ts` (whitelist, cookie names).
- `src/lib/server/auth/`: `passkeys.ts`, `passkey-flow.ts`, `webauthn-verify.ts`, `reauth.ts`, `devices.ts`, `auth-events.ts`, `delete-account.ts`; edits to `session.ts` (metadata on creation; `createPasskeySession`), `throttle.ts` (scopes), `gate.ts` unchanged. `signInWithPassword` callers (login, account) pass the user-agent label for the new session.
- `src/lib/server/settings/prefs.ts` (theme, density, avatar colour, notification prefs), `src/lib/server/export/{tables,account-export}.ts`, `src/lib/server/notifications/repo.ts` (mute-aware insert helper) and the RB-03/RB-09 writers that call it.
- `src/hooks.server.ts`: `transformPageChunk` for the `<html>` attributes and `theme-color`; no change to the CSRF, Access or gate order.
- `src/app.html`: `%ruby.html%` placeholder. `src/lib/ui/kit/`: `GroupList.svelte`, `IconRow.svelte`, extend `Avatar.svelte` with `color`, add a `settings` icon. `src/lib/ui/shell/nav.ts`: `ACCOUNT` → Settings.
- Routes as listed in section 5; `(app)/account/+page.svelte` is deleted, `+page.server.ts` becomes the redirect. `(auth)/login` gains the passkey actions and client code.
- Docs: `docs/RUNBOOK.md` (Passkeys section, rpId and host change, export/delete behaviour, no new secret), `docs/ACCEPTANCE.md`, release note `src/lib/content/releases/0.7.0.md`, `CLAUDE.md` routes line (`/account` → `/settings/**`).

**Reuse, do not rebuild:** `requireUser`, `readFormBody`/`textField`, `signInWithPassword`, `changePassword`, `updateOwnName`, `countAttempt`/`overUserAttemptLimit`, `guardedSessionInsert`, `safeReturnTo`, `newId`/`now`/`sha256Hex`/`randomToken`, `errorLabel`, the kit `Switch`, `Dialog`, `Banner`, `FieldError`, `Avatar`, `LocalTime`.

**Cloudflare Access on/off.** Nothing in this feature reads the Access JWT. Settings, passkeys and sessions depend only on the in-app session cookie and the request host, so behaviour is identical with `ACCESS_DISABLED = "1"` or `""`. The copy on Devices mentions Access only as a static hint (the page does not know whether Access is on; it may state "If your team uses Cloudflare Access, that sign-in is separate"). Passkey `rpId` follows the host the browser used, which is the same host with Access on or off.

**No new dependency.** The WebAuthn verifier, CBOR subset, ZIP writer and user-agent summary are small in-repo modules.

### 4.12 Prerequisites, delivery and trackers

- No new Worker secret, var or binding. Passkeys work on any secure host with a real domain (custom domain or a non-`workers.dev` host); on `*.workers.dev` they are hidden by design.
- Existing: D1 `DB`; R2 is untouched (unless O2). `APP_VERSION` in `wrangler.jsonc` and `package.json` move to 0.7.0 with the release note (RB-11 test). `REMINDER_EMAIL_FROM` absent → the e-mail toggle is hidden (RB-09 behaviour). RB-20 absent → the Install row is hidden.
- Remote migration: apply 0013–0014 with `npm run deploy` after the D1 Time Travel bookmark it records. All additive; no destructive step, so the orchestrator may deploy after gates pass (CLAUDE.md).
- Build order: RB-20 (0.5.0, no migration) and RB-12 (0.6.0, migration 0012) merge first; RB-21 takes 0.7.0 and 0013–0014 (0015 only if O2 flips). RB-16 to RB-19 follow with 0016 to 0019 and versions 0.8.0 to 0.11.0. The engineer rebases `nav.ts` and `schema.ts` carefully (RB-20 and RB-12 also edit them). The three version places (`package.json`, `wrangler.jsonc` `APP_VERSION`, newest `src/lib/content/releases/<version>.md`) must agree or the RB-11 test and `npm run deploy` refuse.
- `docs/TASKS.md`: add "RB-21 Account settings (`/settings` hub, passkeys, devices, appearance, notification prefs, export, delete)" as an open item; on completion move evidence to `docs/HISTORY.md`. Note that migrations 0013 to 0015 are reserved here.
- `docs/ACCEPTANCE.md`: add rows (see section 13, P-level). Existing rows are not moved by this feature.
- `CLAUDE.md`: routes list `/account` → `/settings` and `/settings/**`; owner decisions O1–O12 recorded after the owner answers.

## 5. Routes and UI

All under `src/routes/(app)/settings/`, inside the `(app)` group (signed-in only), with a shared `+layout.svelte` that gives a back link to `/settings` on phones.

| Route | Who | What |
| --- | --- | --- |
| `/settings` | member | Hub: header (initials tile, name, e-mail, role badge) and grouped lists below, one `GroupList` per section, each row an `IconRow` with icon, title, one-line hint and chevron |
| `/settings/profile` | member | Name (existing action), e-mail (read-only), role (read-only), initials colour, job title (read-only, only when `employees.user_id = me`, with a link to `/people/<employee id>`), time zone display |
| `/settings/security` | member | Security hub: Password (inline form, moved), rows to Passkeys, Devices, Sign-in history |
| `/settings/security/passkeys` | member | List, add, rename, remove |
| `/settings/security/devices` | member | Active sessions and sign-out |
| `/settings/security/history` | member | Last 20 sign-in and security events |
| `/settings/appearance` | member | Theme (System / Light / Dark), density |
| `/settings/notifications` | member | In-app toggles per kind, and the RB-09 e-mail reminder toggle (shown only while `emailRemindersConfigured()`) |
| `/settings/privacy` | member | Export my data, Delete my account |
| `/settings/privacy/export/download` | member | `+server.ts`, POST only, returns the ZIP |
| `/settings/privacy/delete` | member | Confirmation page and action |
| `/settings/install` | member | A short page that links to RB-20's guidance; hidden from the hub if RB-20's route does not exist |
| `/settings/about` | member | Version (`APP_VERSION`), What's new (`/releases`), licence (MIT), source (`https://github.com/studiomicro/ruby`), third-party notices |

"Member" here means any signed-in active user, admins included; there is no admin-only route in settings.

Hub order: **Account** (Profile, Security), **App** (Appearance, Notifications, Install), **Data** (Privacy and data), **Ruby** (About). A "Sign out" row sits at the foot of the hub on phones (the sidebar already has it on wide screens).

`/account`: `+page.server.ts` replaced by a loader that `redirect(308, '/settings')` (a 308 keeps any method; GET only matters). `/account?x=…` query is dropped. All links in the app that point to `/account` (calendar page, reminders, nav) move to `/settings` or `/settings/notifications`. `nav.ts`: `ACCOUNT` becomes `{ href: '/settings', label: 'Settings', icon: 'settings' }` (add a gear icon to `Icon.svelte` if missing); the active-state check treats `/settings/*` as active. The RB-11 "What's new" footer item stays.

**States**

- Hub and pages: loading is server-rendered (no spinner); each row link has focus, hover and pressed styles.
- Forms (name, password, theme, toggles): idle, saving (button disabled, label "Saving"), success shown only after the server confirms ("Saved"), error with `FieldError`; fully functional without JavaScript.
- Passkeys: unsupported browser, no rpId (workers.dev or IP), empty, list, cap reached, adding (waiting for the device prompt, cancel allowed), cancelled, refused, removed, error.
- Devices: empty cannot happen (the current device is always listed); signing out one or all: confirming dialog, saving, success.
- Re-auth dialog: password or passkey, wrong password counts toward lockout, locked, success then the original action retries once.
- Export: idle, preparing (browser download starts when headers arrive), too large, throttled, not recently verified.
- Delete: confirmation, wrong proof, last admin ("You are the last active admin. Make someone else an admin first."), throttled, success redirect.

## 6. Data and migrations

| Table | Change | Notes |
| --- | --- | --- |
| `user_prefs` | add | `user_id` PK→users, `theme` CHECK in ('system','light','dark') default 'system', `density` CHECK in ('comfortable','compact') default 'comfortable', `avatar_color` integer CHECK null or between 0 and 7, `updated_at` |
| `user_notification_prefs` | add | `user_id`→users, `kind` CHECK in the four kinds, `in_app` integer CHECK in (0,1), `updated_at`, PRIMARY KEY (`user_id`, `kind`) |
| `user_calendar_prefs` | none | Kept; the RB-09 toggle keeps its table |
| `passkeys` | add | `id`, `user_id`→users, `credential_id`, `public_key`, `algorithm` CHECK in (-7,-257), `counter`, `transports` JSON text, `aaguid`, `name` ≤ 40, `rp_id`, `backed_up`, `created_at`, `last_used_at`, `updated_at`, `deleted_at`; partial unique index on `credential_id` where `deleted_at IS NULL`; index `(user_id, created_at)` |
| `passkey_challenges` | add | `id`, `challenge` unique, `kind` CHECK in ('register','sign_in','reauth'), `user_id`, `created_at`, `expires_at`, `used_at`, `used_by`; content CHECK |
| `auth_events` | add | `id`, `user_id`→users, `kind` CHECK in the nine kinds, `device` text ≤ 60, `passkey_id`, `created_at`; index `(user_id, created_at)` |
| `sessions` | alter | `ADD COLUMN user_agent text, auth_method text, passkey_id text, reauth_at integer` (plain column additions, no rebuild of `sessions`); `auth_method` has no CHECK in SQLite ADD COLUMN beyond a column-level one in ('password','passkey','invite','setup') |
| `users` | alter | `ADD COLUMN deleted_at integer` (column add, **no rebuild of `users`**, which has 36 foreign keys and a status CHECK; same reason RB-05 added `is_hr` this way) |

Files, in apply order (never edit an applied migration):

- `migrations/0013_user_settings.sql`: `user_prefs`, `user_notification_prefs`.
- `migrations/0014_passkeys_sessions_events.sql`: `passkeys`, `passkey_challenges`, `auth_events`, the `sessions` and `users` column additions. All statements `IF NOT EXISTS` where SQLite allows so they are re-runnable; `schema.ts` mirrors them without a table CHECK on `users`.
- `migrations/0015_avatars.sql`: only if the owner flips O2 (avatar upload); adds `user_prefs.avatar_key`. Otherwise 0015 is not used and RB-16 keeps 0016.

Confirm the numbers are free at merge: 0012 belongs to RB-12 and 0016 to 0019 to RB-16 to RB-19 (`docs/features/rb-15-tracker-roadmap.md`).

## 7. Limits

| Limit | Value | Where enforced |
| --- | --- | --- |
| Name length | 1–80 characters, trimmed | `updateOwnName`, `cleanText` |
| Avatar colour | integer 0–7 or null | action and CHECK |
| Live passkeys per account | 10 | guarded INSERT … SELECT, `shared/passkeys.ts` |
| Passkey name | ≤ 40 characters | `shared/passkeys.ts`, CHECK |
| Passkey algorithms | ES256 (−7), RS256 (−257) | verifier, CHECK |
| Challenge TTL | 5 minutes | `passkey_challenges.expires_at` |
| Re-authentication window | 5 minutes | `auth/reauth.ts` |
| Devices listed | 50 live sessions | `devices.ts` |
| Device label | ≤ 60 characters; input header > 512 chars → "Unknown device" | `summarizeUserAgent` |
| Sign-in history shown | newest 20 | history loader |
| Sign-in history kept | 90 days, newest 200 per user | opportunistic delete on next insert |
| `sign_in_failed` rows | 1 per user per minute | `auth-events.ts` |
| Export rows | 50,000 across all sets | counted first in SQL; refusal over the cap |
| Export page size | 500 rows (keyset) | `account-export.ts` |
| Export notifications | last 90 days | `account-export.ts` |
| Throttle `passkey-begin` | 60 / 10 min per client (conditional UI issues one challenge per `/login` load) | `throttle.ts` |
| Throttle `passkey-finish` | 20 / 10 min per client | `throttle.ts` |
| Throttle `settings-manage` | 30 / 10 min per user (passkey options, rename, remove, revoke, prefs writes that touch D1 more than once) | `throttle.ts` |
| Throttle `data-export` | 2 / 10 min per user, counted before any query | `throttle.ts` |
| Throttle `account-delete` | 5 / 10 min per user | `throttle.ts` |
| Throttle `account-password` (existing) | 20 / 10 min per user, also used by re-auth by password | `throttle.ts` |
| Avatar upload (only if O2 = yes) | 1 MB, PNG/JPEG/WebP, throttle `avatar-upload` 5 per window | upload action |

New throttle scopes go into `THROTTLE_SCOPES` and each fails closed like the rest. Preference toggles are single upserts and use `settings-manage` only. A 429 carries `Retry-After` from `retryAfterSeconds`.

## 8. Authorization

Every load, action and route starts with `requireUser(event)`. **No route in `/settings` accepts a user id**: the subject is always `event.locals.user.id`, never a form field. Session ids and passkey ids from forms are always combined with `user_id = me` in the same statement, so another user's id, an unknown id and a deleted id all answer an identical 404. An admin has no extra right here: `requireAdmin` is not used, and an admin POSTing another user's session or passkey id gets the same 404 a member gets.

| Action | Rule | Fresh proof |
| --- | --- | --- |
| View hub, profile, appearance, notifications, about | signed-in active user | no |
| Change name, avatar colour, theme, density, toggles | own row only | no |
| Change password | own, current password required | password (existing) |
| Passkey list, rename | own | no |
| Passkey add, remove | own | **yes** (window) |
| Passkey sign-in | anonymous request, credential must resolve to an active, non-deleted user | the assertion itself |
| List devices, sign out one | own sessions; not the current one | no |
| Sign out all others | own | **yes** (window) |
| Sign-in history | own rows | no |
| Export | own data | **yes** (window) |
| Delete account | own; last active admin refused | **yes, inline** |
| Redirect `/account` | signed-in; signed-out goes to `/login` first via the gate | no |

A signed-out request gets the existing sign-in redirect (GET) or 401; a deactivated user's session is already rejected by `resolveSession` on the next request. Passkey sign-in `begin`/`finish` live in `(auth)` and so are reachable signed out, throttled per client.

## 9. Concurrency and failure states

- **Passkey cap:** the insert is `INSERT … SELECT … WHERE (SELECT count(*) FROM passkeys WHERE user_id = ? AND deleted_at IS NULL) < 10` and consumes the register challenge in the same batch; 11 concurrent adds produce at most 10 rows.
- **Challenges:** consumed once by `UPDATE … SET used_at = ? WHERE challenge = ? AND used_at IS NULL AND expires_at > ? RETURNING`; a replayed or concurrent second use writes nothing. Challenge is bound to its kind and (for `register`/`reauth`) to the user.
- **Counter rollback:** `UPDATE passkeys SET counter = ? WHERE id = ? AND (counter < ? OR ? = 0)`; a lower non-zero counter is refused, writes `auth_events` no row beyond a content-free refusal, and logs a label only.
- **Passkey remove vs sign-in:** removal soft-deletes (`deleted_at`) and revokes that passkey's sessions in one batch; a sign-in finishing at the same time inserts its session through `guardedSessionInsert` guarded on the passkey still live, so it cannot outlive the removal.
- **Sessions:** revoke statements are idempotent; "sign out all others" is one guarded UPDATE excluding the current token hash; a session created during the same moment is either covered or created after, never half-revoked.
- **Password change vs revoke:** unchanged batch from `changePassword`.
- **Re-auth stamp:** set on the one session row; a revoked session cannot be stamped.
- **Preferences:** upsert per row (`ON CONFLICT (user_id) DO UPDATE`), last write wins per field; two tabs toggling different fields do not overwrite each other because each action updates only its own columns.
- **Delete:** one batch, markers and guards as in 4.9; last-admin race proven by a test with two admins and `Promise.all`. A concurrent export/session request after the mark is refused because the user is disabled.
- **Export while editing:** each page read is a consistent snapshot per query; the ZIP is "as of" a rolling read, documented in README.txt. A mid-download deletion ends the stream (user re-checked each page).
- **Missing prerequisite:** no `REMINDER_EMAIL_FROM` hides the e-mail toggle and its action answers 404; no rpId (IP literal or `*.workers.dev`) shows the passkey unavailable state and the options action answers 400; RB-20 absent hides the Install row.

## 10. Mobile and accessibility

- Verified at **402×874, 440×956 and 360 px** by extending the Playwright viewport spec (`e2e/`): `/settings`, `/settings/security`, `/settings/security/passkeys`, `/settings/security/devices`, `/settings/appearance`, `/settings/notifications`, `/settings/privacy`. No horizontal page scroll; no element wider than the viewport.
- Hub and sections are **grouped list rows**: a rounded `GroupList` per section, rows at least **44 px** high (target 56 px with hint), 16 px horizontal gutter, section heading above each group, chevron on the right, dividers between rows. New kit components `GroupList.svelte` and `IconRow.svelte` in `src/lib/ui/kit/` (RB-10 tokens only, no new colours).
- Switch rows, swatches, segmented theme control, "Sign out" buttons and dialog buttons: at least 44×44 px targets. Inputs 16 px or larger (no iOS zoom). Dialogs and confirmation sheets pin to the bottom on phones and pad by `--sai-bottom`; the page pads the phone tab bar and `--sai-*`; the back link in the layout is a 44 px button.
- Wide screens (≥ 768 px): the same pages in a centred column (max about 640 px) inside the shell; no second pane.
- Device and passkey lists wrap labels (no truncation of the "This device" badge); long names `overflow-wrap: anywhere`.
- Swatches carry a check and `aria-checked`; the theme control is a labelled segmented control; the re-auth dialog traps focus and returns it on close.

## 11. Security and privacy

- **Privacy posture.** Device label, event names and times are the only new personal data; no IP, no raw user agent. Both ends are covered by the table-decision test (export and delete).
- **Never log:** passkey ids, challenges, public keys, user agent text, e-mail or names in `console` output; error paths use `errorLabel`. Secrets and hashes are never serialised to page data.
- **Markdown safety:** no user text in settings pages is rendered as Markdown or `{@html}`; names and device labels are escaped text.
- **Threats and controls:** assertion replay and cross-user credential use (challenge once-only, `userHandle` check, credential owner check); challenge fixation (kind and user binding); re-auth stamp reuse (current session only); session id enumeration (identical 404, `user_id = me` in the statement); export scope leaks (own rows only, two-user leak test); delete race and last-admin bypass (guarded single batch); cookie injection into `data-theme` (whitelist before `transformPageChunk`); CSRF on download and delete (hook plus POST only); Access JWT bypass on `/settings/**` (hook order unchanged).
- Passkeys do not replace or bypass Cloudflare Access; they replace typing the password at `/login`.

## 12. Acceptance criteria

Verification level in brackets: **A** = Automated (Vitest on local D1), **E** = Playwright, **M** = Mocked, **P** = Pass on a deployed host (owner or orchestrator check). Playwright (E) runs outside `gates` per `CLAUDE.md`.

**Access, routing and navigation**

- [ ] AC1 [A] Given a signed-out request, when it GETs any `/settings/**` route, then it is redirected to `/login?next=…`; when it POSTs any settings action or the export, then 401.
- [ ] AC2 [A] Given a deactivated user's session, when it requests `/settings`, then it is refused as every other `(app)` route is.
- [ ] AC3 [A][E] Given a signed-in user, when they GET `/account`, then 308 to `/settings`; the sidebar and More sheet show "Settings" and highlight it on `/settings/*`; no in-app link points to `/account`.
- [ ] AC4 [A] Given an admin and a member, when each opens the hub, then they see the same sections; the admin has no extra row and no admin route is linked.

**Profile**

- [ ] AC5 [A] Given a name of 1–80 characters, when saved, then it persists across reload and appears in the shell; empty, whitespace-only or 81 characters answers 400 with a field error.
- [ ] AC6 [A][E] Given an avatar colour 0–7, when saved, then that user's tile shows it in the shell, comments and directory; 8, −1 or text answers 400; unset falls back to the derived colour.
- [ ] AC7 [A] Given a user linked to an employee record, when Profile loads, then it shows the job title read-only with a link to the profile; given no link, no job-title row; no tier 1–3 value is ever in page data.
- [ ] AC8 [E] The time zone block shows the team zone and (client-side only) the device zone; there is no input.

**Password**

- [ ] AC9 [A] Given the correct current password and a valid new one, when submitted, then the password changes, every other session is revoked, this session stays, `password_changed` is recorded. A wrong current password counts toward lockout; a concurrent second change does not both commit.

**Passkeys**

- [ ] AC10 [A][E] Given `rpId` is available, when a user registers a passkey (virtual authenticator) after a fresh proof, then a row exists, the list shows it without key material, `passkey_added` is recorded; without a fresh proof the action answers 403 `reauth_required` and writes nothing.
- [ ] AC11 [E][A] Given a registered passkey, when the user signs in with it (conditional UI and the button), then a session is created, `last_login_at` is set, the replaced cookie's session is revoked, and `/login?next=` is honoured through `safeReturnTo`.
- [ ] AC12 [A] Given a replayed assertion, a challenge used twice, an expired challenge (> 5 min), a wrong origin, a wrong rpId hash, a wrong type, a wrong `userHandle`, a lower counter, a removed passkey, a deactivated or deleted user, then sign-in is refused with the generic sign-in failure and no session row exists.
- [ ] AC13 [A] Given 10 live passkeys, when an 11th is added (also 11 concurrent adds), then at most 10 exist and the page shows the cap message.
- [ ] AC14 [A] Given a passkey removal after a fresh proof, then it is soft-deleted, its sessions other than the current one are revoked, `passkey_removed` is recorded; another user's passkey id answers 404 and changes nothing.
- [ ] AC15 [A] Given an IP-literal or `*.workers.dev` host, then the passkey UI shows the unavailable state and the options action answers 400; password sign-in is unaffected.
- [ ] AC16 [A] Given `ACCESS_DISABLED` = "1" and given Access required with a valid JWT, then passkey registration, sign-in and removal behave identically; with Access required and no valid JWT, every settings and passkey route is refused by the hook as today (403/503).

**Devices and history**

- [ ] AC17 [A] Given a user with three sessions (one expired, one revoked), when Devices loads, then only live sessions show, the current one is marked "This device", labels come from the stored summary, and no IP or raw user agent is in page data.
- [ ] AC18 [A] Given "Sign out" on another session, then that session stops resolving on its next request; the current session cannot be revoked there; another user's session id answers 404. Given "Sign out all other devices" with a fresh proof, then every other live session is revoked and this one stays; without a proof 403.
- [ ] AC19 [A] `summarizeUserAgent` maps representative Chrome/Safari/Firefox/Edge/iOS/Android strings to labels and returns "Unknown device" for empty, oversized (> 512 chars) and malformed input; the stored value is ≤ 60 characters.
- [ ] AC20 [A] History shows at most 20 newest own events; events older than 90 days are removed on the next write; `sign_in_failed` rows appear only for an existing active account and at most one per minute; no row holds an IP or raw user agent.

**Appearance**

- [ ] AC21 [A][E] Given theme "dark" saved, when any page (including `/login`) is requested with the cookie, then the HTML response already contains `data-theme="dark"` on `<html>` (no client script needed, verified by fetching the raw HTML) and the page renders dark on first paint; "system" leaves the attribute off.
- [ ] AC22 [A] Given a tampered cookie value, then the page renders as system and no error is raised. Given a new device (no cookie), the layout sets the cookie from the stored preference.
- [ ] AC23 [A] Compact density is disabled in the UI and rejected by the action (400) while O7's default holds; the column still stores `comfortable`.
- [ ] AC24 [A] The CSP header is byte-identical to today's for `/` and `/settings/appearance`.

**Notifications**

- [ ] AC25 [A] Given "Comments" turned off, when another user comments on this user's task, then no `comments` notification row is created for them; the other kinds still are; existing rows remain; turning it back on resumes creation. A concurrent comment and toggle never leaves a row after the toggle committed.
- [ ] AC26 [A][M] Given reminders muted in-app, then the reminder still fires and (when opted in) e-mails; only the notification row is skipped.
- [ ] AC27 [A] Given no `REMINDER_EMAIL_FROM`, then the e-mail toggle row is absent and its action answers 404; given one, it behaves as RB-09 did on `/account`.

**Export**

- [ ] AC28 [A] Given a fresh proof, when exporting, then the response is a valid ZIP with the listed files; each set contains only rows owned by the requester; a second user's tasks, comments, e-mail, HR tables and `hr_audit_log` never appear (seeded test with two users and an HR record).
- [ ] AC29 [A] Given no fresh proof, 403; given 3 exports in 10 minutes, the third answers 429 with `Retry-After`; given more than 50,000 rows, a refusal and no partial download.
- [ ] AC30 [A] The ZIP is produced from keyset pages (a test with 1,500 comments proves more than one page and flat memory by counting queries), is deterministic for unchanged data, and carries `no-store`, `attachment` and `nosniff`.
- [ ] AC31 [A] The export table-decision test fails if a schema table with a `users` foreign key is missing from `tables.ts`.

**Delete**

- [ ] AC32 [A][E] Given the correct password (or a fresh passkey assertion) and the typed e-mail, when a member deletes their account, then: the user row is anonymised and disabled, sessions/passkeys/prefs/credential/personal reminders are gone, tasks, comments, pages, revisions and attachments by that user remain and display "Former member", the real e-mail can be invited again, and the user cannot sign in.
- [ ] AC33 [A] Given the last active admin, then delete answers 409 with the message and nothing changes; given two admins deleting concurrently, exactly one succeeds.
- [ ] AC34 [A] Given a wrong password, a wrong typed e-mail, a throttled client or a password changed meanwhile, then nothing is deleted.
- [ ] AC35 [A] Given a linked employee record, then it is untouched and still linked, and one `hr_audit_log` row `account_deleted` with no values exists; the directory still lists the employee.
- [ ] AC36 [A] Given a deleted user, then `/admin/users` lists them read-only under "Deleted accounts" with no reactivate or role control, and the last-admin and invite checks ignore them.
- [ ] AC37 [A] Soft-deleted and restored tasks or pages authored by a deleted user restore normally; FTS rows are unchanged by anonymisation (titles and bodies, not author names).

**General checklist (`docs/ENGINEERING_CHECKLIST.md`)**

- [ ] AC38 [A] Every new load, action and `+server.ts` starts with `requireUser`; no handler reads a user id from input.
- [ ] AC39 [A] D1 limits: no `inArray` on growable lists (use `json_each`), no LIKE patterns, bounded row caps on every list, batches for multi-write steps.
- [ ] AC40 [A] Timestamps are UTC ms; the UI formats in the browser only (`LocalTime`).
- [ ] AC41 [A] Never log: no passkey ids, challenges, public keys, user agent text, e-mail or names in `console` output; error paths use `errorLabel`. Secrets and hashes never serialised to page data (test greps the loader JSON).
- [ ] AC42 [E] Loading/empty/error/saving/success states exist for every page above; success appears only after the server confirms; every form works with JavaScript disabled except the passkey ceremony.
- [ ] AC43 [E] Mobile: no horizontal scroll and 44 px targets at 360, 402 and 440 px on the listed pages.
- [ ] AC44 [A] Markdown output safety: no user text in settings pages is rendered as Markdown or `{@html}`; names and device labels are escaped text.

## 13. Test plan

| Layer | File | Covers |
| --- | --- | --- |
| Vitest unit and integration (local D1) | `test/**` (names set by the engineer): `webauthn-verify` (spec vectors and Chrome/Safari fixtures, bad inputs), `passkey-flow` (challenge lifecycle, rpId rules, counter rollback, replay), `passkeys` repo (cap race, ownership, soft delete) | AC10–AC16 |
| Vitest | `session` (new columns, `createPasskeySession` guard), `reauth` (window, stamp on current session only), `devices` (list, revoke one, revoke all, 404 on foreign id), `summarizeUserAgent`, `auth_events` (retention, failed-sign-in cap) | AC17–AC20, AC9 |
| Vitest | `prefs` (cookie whitelist, hook attribute fill, tampered value), notification mute (concurrent), account redirect, throttle scopes | AC1–AC8, AC21–AC27 |
| Vitest | `export` (ownership, two-user leak test, cap, throttle, keyset paging, ZIP validity, table-decision test), `delete-account` (matrix by table, last-admin race with `Promise.all`, wrong proofs, HR audit) | AC28–AC37 |
| Vitest | third-party notices coverage, version consistency (RB-11 test with 0.7.0), a loader-JSON secret scan | AC38–AC41, AC44 |
| Playwright | `e2e/settings.spec.ts` with a CDP virtual authenticator (Chromium): register, conditional sign-in, remove, re-auth dialog with password and with passkey; devices page with two browser contexts and remote sign-out; theme persists across reload and `/login` has no flash (assert `data-theme` in the first HTML); notification toggle; export download opens as a ZIP with expected names; delete flow as a member | AC3, AC6, AC8, AC10, AC11, AC21, AC32, AC42 |
| Playwright viewport spec | existing viewport spec extended to 402/440/360 for the listed pages | AC43 |
| Manual [P] | on a deployed host with Access on, and again with `RUBY_ACCESS_DISABLED=1` on a throwaway deployment or by test configuration: register a real passkey on a phone (Face ID) and a laptop, sign in with each, remove one, confirm sessions of the removed passkey end; confirm rpId behaviour on the custom domain | AC10–AC16, device names and versions recorded |

- WebKit/Safari passkeys are not automatable here.
- `docs/ACCEPTANCE.md` gains rows for: passkey register and sign-in, remote session sign-out, theme without flash, export own data only, delete keeps team content; they stay "Not run" until the owner or the orchestrator runs the deployed check.
- **Pipeline:** QA report and red-team report are required (Large). Red team targets: assertion replay and cross-user credential use, `userHandle` mismatch, challenge fixation, re-auth stamp reuse across sessions, session id enumeration, export scope leaks (IDOR via ids in filters), delete race and last-admin bypass, cookie injection into `data-theme`, CSRF on download and delete, Access JWT bypass on `/settings/**`.

## 14. Owner decisions

| # | Decision | Options | Default | Answer |
| --- | --- | --- | --- | --- |
| O1 | Passkeys (WebAuthn) as a second way to sign in | Yes / No | **Yes.** Password stays the primary credential and every account keeps one. Passkeys never replace Cloudflare Access; they replace typing the password at `/login` | pending |
| O2 | Avatar | Initials tile with user-chosen colour / photo upload | **Initials tile with a user-chosen colour (8 token colours)**. Photo upload is **not built**. If the owner says yes: see "Avatar upload addendum" below (R2, 1 MB, PNG/JPEG/WebP, served through an authorised route; migration `0015_avatars.sql`) | pending |
| O3 | Who may delete their own account | Members and admins / members only | **Members and admins both**, with re-authentication and a typed confirmation. The last active admin cannot (they must promote another admin first) | pending |
| O4 | What happens to authored content on delete | Anonymise the author / delete authored pages and comments | **Anonymise the author, keep the team content.** Tasks, pages, revisions, comments, events and attachments stay; the author shows as "Former member". Personal-only data (reminders, notification rows, preferences, sessions, passkeys, history) is deleted. Deleting the user's authored pages and comments is **not** offered: it breaks threads and revision history | pending |
| O5 | HR records on delete | Stay with HR / delete with the account | **Stay with HR (RB-05 rules).** The employee row is kept and stays linked; HR sees "account deleted" and handles offboarding (RB-07). One `hr_audit_log` row (action only, no values) | pending |
| O6 | Data export format | One ZIP / other | **One store-only ZIP**: `README.txt`, JSON per data set and CSV for tasks, comments and time off. Bounded (50,000 rows, 2 per 10 minutes) and streamed | pending |
| O7 | Density (comfortable / compact) | Setting only, comfortable shipped / compact visuals now | **Build the setting and the attribute, ship comfortable only** (the compact toggle is shown disabled with "Coming soon" until RB-10 tokens define compact). Stored so no later migration is needed | pending |
| O8 | Re-authentication window | 5 minutes / other | **5 minutes** after a successful password or passkey proof, for passkey add/remove, export and revoke-all. **Delete always proves inline**, in the same request | pending |
| O9 | Sign-in history | 20 events, 90 days / other | **Last 20 events, kept 90 days, no IP address and no raw user agent** (a short label like "Chrome on macOS"). Failed sign-ins for an existing account are included | pending |
| O10 | Time-off decision notifications | Deferred / add the kind now | **Deferred.** RB-06 writes no notification today; adding a kind means rebuilding `notifications` again (as RB-09 did). The toggle is not shown until a later item adds the kind. Notifications settings ship with mention, assigned, comment and reminder | pending |
| O11 | Time zone setting | Display only / per-user override | **Display only** (team time zone and device zone). No per-user override: `TEAM_TIME_ZONE` rules the calendar (RB-09 O8) | pending |
| O12 | Release version | 0.7.0 / other | **0.7.0** (RB-20 0.5.0, RB-12 0.6.0, RB-21 0.7.0, then RB-16 to RB-19 at 0.8.0 to 0.11.0). The final number is whatever is next free when RB-21 merges; the three version places must agree | pending |

### Avatar upload addendum (only if O2 = yes)

`AVATAR_UPLOAD` is a plain var (`"1"` enables). PNG/JPEG/WebP only, magic-byte sniffed (not the client MIME type), 1 MB cap, one object per user at server-generated key `avatars/<user id>/<random>` (R2 object written first, then the D1 `avatar_key`, object deleted on failure, old object deleted after the swap); served at `/avatars/[userId]` after `requireUser` with `nosniff`, a fixed image content type and `Cache-Control: private, max-age=300`; users deleted → object deleted in the delete flow after the batch (best effort plus a sweep on the next upload); no EXIF stripping is possible in Workers, so the page says photos keep their metadata. Throttle scope `avatar-upload` 5 per window. Not built under the default.

## 15. Out of scope / later

- Settings that do not apply to Ruby: plan and credits, vouchers, API tokens and API docs, usage stats, feature flags, categories, merchants, connected apps, AI key, assistant memory, push subscriptions, Telegram/Gmail, money anything.
- Profile photo upload (unless O2 flips), per-user time zone override, language switch, custom themes, density "compact" visuals (O7).
- Two-factor authentication by authenticator app or SMS, recovery codes, password-less accounts (every account keeps a password), account e-mail change, e-mail verification (no mail path besides RB-09 reminders).
- Admin tools over another user's settings (reset passkeys, view devices): explicitly **not** provided; an admin who must lock someone out deactivates them at `/admin/users`.
- Deleted-account restore, a grace period, an export of attachment bytes, a self-service view of one's HR record, scheduled or emailed exports, import.
- Time-off decision notification kind (O10); changing the 30-day session life; IP or geo logging.
- Bot check (Turnstile) on login: Ruby has Access and the per-client throttle.

## 16. Release note draft

> **Settings (0.7.0).** `/account` is now Settings. Update your name and initials colour, change your password, add passkeys to sign in without typing a password, and see and sign out your other devices. Choose light, dark or system theme, turn off in-app notifications by kind, download your own data as a ZIP, or delete your account (your tasks, pages and comments stay for your team as "Former member"). Compact density, profile photos and per-person time zones are not available yet.
