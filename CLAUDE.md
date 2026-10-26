# RUBY — Project Context

## Goal and source of truth

Ruby is the internal project-management and knowledge-base app of one team. It is open source (MIT, `https://github.com/studiomicro/ruby`) and
is built by Macan Teknologi Perkasa. People plan work as projects and tasks (list and board) and write down
what the team knows as Markdown pages, with comments, @mentions, notifications, attachments and full-text search.

- Owner decisions of 2026-10-26 fix the scope below. Status and evidence: `docs/TASKS.md`, `docs/HISTORY.md`,
  `docs/ACCEPTANCE.md`. Operations: `docs/RUNBOOK.md`.
- Feature ids use `RB-NN`: RB-00 foundation (auth, Access, shell, UI kit, Markdown), RB-01 projects and tasks (list and
  board), RB-02 knowledge base (page tree, Markdown, revisions, FTS search), RB-03 comments, @mentions and
  notifications, RB-04 attachments (R2), RB-05 employee directory, profiles, org chart and HR access, RB-06 time off,
  RB-07 onboarding and offboarding checklists, RB-08 project management plus (`docs/features/rb-05-hrm-roadmap.md`).
- Inspect existing code and instructions first; preserve unrelated edits.

## Product boundaries

- One team, one organisation. Not a public product: no public sign-up, no billing, no multi-tenancy, no marketing site.
- Every active user sees every project, task and page. There are no per-project permissions. Only admins manage users.
- HR data is the one exception to "every active user sees everything"; see `docs/features/rb-05-hrm-roadmap.md`
  section 4. Employees are records separate from accounts. The capability flag `users.is_hr` (granted by an admin at
  `/admin/users`, audited) makes a user HR; admin is not HR by itself. Tier 0 (directory fields) is for every active
  user, tier 1 (employment) for self, the direct manager and HR, tier 2 (NIK, NPWP, BPJS, bank, address, personal
  contacts) for self and HR, tier 3 (salary) for HR only. Tier 2 and 3 values are AES-256-GCM encrypted with the
  Worker secret `HR_DATA_KEY`, masked, and revealed one at a time by an audited action, never in a page load; while
  the secret is unset or malformed they are read-only ("not configured"). Every reveal and change of tier 2/3 data,
  every export and every HR grant writes an append-only `hr_audit_log` row (field names only).
- Two roles: `admin` and `member`. The first user, created at `/setup` while the user table is empty, is the admin.
  Admins invite others by e-mail; an invite is a single-use, expiring token. Admins can deactivate users; they cannot
  deactivate or demote the last active admin.
- English UI only. No i18n layer, no language switch.
- No AI, no queues, no background jobs, no e-mail sending beyond what an owner decision adds later. Invite links are
  shown to the admin to copy until an e-mail path is approved.
- Data in Ruby is the team's internal work. Never log page text, comment text or attachment names at info level.
- Never log employee personal data (names, contact details, identifiers, salary, any tier 1–3 value) at any level,
  and never write a value to the HR audit log: field names only.

## Locked architecture (Cloudflare)

- Svelte 5 + SvelteKit 3 + TypeScript + Vite; Tailwind CSS v4; small Svelte-native components, no UI framework.
- `@sveltejs/adapter-cloudflare`; **one app Worker** owns SSR, loaders, form actions and API routes. No jobs or inbound
  Workers, no Queues, no KV, no Workers AI. Single production environment: no staging.
- D1 database `ruby`, R2 bucket `ruby-files` bound as `FILES`, in the deployer's own Cloudflare account.
- The repository is public: `wrangler.jsonc` holds zero placeholders (account id, D1 id, app host, Access team domain and
  AUD, `ACCESS_DISABLED` = `""`). Real values live in the environment or the gitignored `.deploy.env`
  (`.deploy.env.example`); `npm run deploy` renders a gitignored `wrangler.deploy.generated.jsonc` and uses it for every
  wrangler call. Never commit an id, hostname, e-mail address or token of a real deployment; use `example.test` /
  `example.com` in tests and docs. `npm run types:cf` generates plain `string` vars.
- D1 + Drizzle. Schema in `src/lib/server/db/schema.ts`; numbered SQL migrations in `migrations/` (`0000_init.sql`,
  `0001_search.sql`, …). Never edit an applied migration; add a new one.
- Search: FTS5 tables `pages_fts` and `tasks_fts`, maintained by triggers created in migration 0001. Application code
  never writes to them directly. Queries go through one search module that escapes user input into a safe MATCH
  expression.
- **SvelteKit 3 facts:** config in `vite.config.ts`; shared imports `#lib/*`; the Cloudflare adapter does not populate
  `event.platform`, so bindings come only through the env helper `getEnv()` in `src/lib/server/env.ts`; `dev`
  comes from `$app/env`.
- **Access and auth, two layers:**
  1. Cloudflare Access sits in front of the whole host. The app verifies the `Cf-Access-Jwt-Assertion` JWT (signature
     against the team's JWKS, `aud` = `ACCESS_AUD`, issuer = `https://<ACCESS_TEAM_DOMAIN>`, expiry). On a deployed
     host a missing or invalid JWT, or missing `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`, **fails closed** (503 while the vars are
     empty, 403 for a missing or invalid JWT). Only loopback hosts (`secureDeployment(hostname)` false) skip the check.
     A deployment may switch Access off with `ACCESS_DISABLED = "1"` (exactly; `RUBY_ACCESS_DISABLED=1` in
     `.deploy.env`). The committed default is `""`: Access required.
  2. In-app invite-only accounts: e-mail + password, opaque session cookie whose token is stored hashed in D1.
     Password hashing uses the strongest parameters the Workers CPU cap allows (PBKDF2-SHA256 via WebCrypto, with a
     per-user salt and a stored iteration count). Sign-in answers identically for unknown e-mail and wrong password.
- Vitest for unit and integration tests against local D1. Playwright only for the viewport/layout spec (owner request 2026-10-26), outside `gates`.
- No Redis, Kafka, Kubernetes or mandatory Docker.

## UI and routes

- Calm, dense, keyboard friendly. Light and dark via CSS variables and `prefers-color-scheme`. Usable from 360 px up.
- Owner request 2026-10-26: auto layout for iPhone 17, iPhone 17 Pro and iPhone 18 Pro (402×874 CSS px, Dynamic
  Island, home indicator), plus 440×956 and 360 px. `viewport-fit=cover`; safe areas are read only through the
  `--sai-*` variables in `src/app.css`; below 768 px the sidebar becomes a bottom tab bar padded by `--sai-bottom`;
  no horizontal page scroll; inputs at least 16 px. Checked by the Playwright viewport spec (`npm run test:e2e`).
- Routes: `/setup` (only while no user exists), `/login`, `/invite/[token]`, `/` (home), `/my-tasks`, `/projects`,
  `/projects/[key]` (list and board views), `/projects/[key]/tasks/[number]`, `/kb` (knowledge base pages, view,
  edit, revisions), `/search`, `/notifications`, `/account` (profile, password), `/admin/users` (admin only), an
  authorised attachment download route (RB-04 PRD), `/people` (directory, `/people/[id]` profile and
  `/people/[id]/edit` for HR), `/people/org` (org chart), `/hr/audit` (HR and admins), `/hr/export` (HR, CSV), and
  from RB-06/RB-07 `/time-off` and `/onboarding`. The feature PRDs under `docs/features/` give the exact trees.
- Every primary action works or shows why it is unavailable. Loading, empty, error, saving and success states exist;
  success is shown only after the server confirms the write. Forms work without JavaScript where SvelteKit allows it.
- Text shown to users never contains a file path or internal identifier.

## Data and runtime conventions

- Timestamps are UTC milliseconds (integer). Format for display in the browser only.
- User-data tables have `id`, `created_at`, `updated_at` and, when a row can be deleted, `deleted_at`. Deleting is a
  **soft delete**: set `deleted_at` and leave the row. Every query for live data filters `deleted_at IS NULL`.
  Tombstoned pages and tasks stay in the FTS tables (the triggers index title and body only); every search query joins
  the base table and filters `deleted_at IS NULL`. A restore clears `deleted_at`.
- **Authorization:** every load, form action, API route and file download starts with the shared `requireUser(event)`
  or `requireAdmin(event)` helper. Admin routes use `requireAdmin`. A hidden button is not authorization. Hidden and
  missing ids give the same answer.
- **Markdown** is rendered only through `src/lib/shared/markdown.ts` (markdown-it with `html: false`, link and image
  URL validation). Rendered output may be used with `{@html}` only from that module. Never call markdown-it elsewhere.
- Page edits create a revision row in the same `db.batch` as the page update. Concurrent edits compare `updated_at`
  and answer "changed meanwhile" instead of overwriting.
- Attachments: bytes live in R2 under a server-generated key (never built from user input); metadata lives in D1;
  downloads go through `/files/[id]` after `requireUser` and a live-parent check; the response sets
  `Content-Disposition`, `X-Content-Type-Options: nosniff` and a safe content type. Size cap 25 MB per file.
- @mentions live in the comment body as `@[Name](user:<id>)` and are re-derived on save (no join table); notifications are rows in D1 read by the
  recipient only.
- Typed bindings only through the env helper; server code in `src/lib/server`, shared pure code in `src/lib/shared`.
  Worker secrets: `HR_DATA_KEY` (RB-05 field encryption, base64url of 32 random bytes; `docs/RUNBOOK.md`).
  Never serialise secrets, password hashes, session tokens or invite tokens in loaders or page data.
- D1 is SQLite: parameterised, bounded queries; `db.batch`, no interactive transactions; no transaction spans D1 and
  R2. Write the R2 object first, then the D1 row; on failure delete the object.

## Verification

- Deterministic fictional seed data for local review (`npm run db:seed:local`), never loaded into production.
- Never report an unrun command as passed. Record what ran, its exit code and its decisive output line.
- Test with two roles (admin, member) and a deactivated user, soft delete and restore, FTS consistency after create,
  edit, delete and restore, Markdown XSS vectors, attachment download as signed-in and signed-out, invite token reuse
  and expiry, and an Access JWT that is missing, expired, wrong audience or wrong signature.

## Execution and repo workflow

- Keep `docs/TASKS.md` current; finished items and evidence move to `docs/HISTORY.md`; `docs/ACCEPTANCE.md` rows
  change only with a named check.
- npm script contract: `dev`, `check`, `lint`, `test`, `build`, `gates`, `types:cf`, `db:generate`,
  `db:migrate:local`, `db:seed:local`, `db:reset:local`, `deploy`. Verify before describing them as runnable.
- Local and remote migration commands stay clearly separate. Never seed or reset the remote database.
- `npm run deploy` (`scripts/deploy.ts`) renders the generated config from `.deploy.env`, records a D1 Time Travel
  bookmark, applies remote migrations, builds and runs `wrangler deploy`; `--dry-run` and `--write-config` exist. It is the only way production changes. This file grants no permission to buy services, create
  provider accounts or change production by any other route.
- Owner decision 2026-10-26: there is one environment and no staging. After the gates pass, the orchestrator may run
  `npm run deploy`. If the gates fail, or a migration is destructive, do not deploy; report instead.
- A private repository is the deploy source; the public repository is `studiomicro/ruby`. Branch `main`. CI runs `npm run gates` on Node 22. There is no deploy
  workflow; deploys run from a trusted machine.
- Each completion report: working behaviour, checks run with results, untested parts, next task.

## Multi-agent pipeline and session workflow

Agents in `.claude/agents/`: **cto-strategist** (request → `docs/features/<slug>/PRD.md` with RB id),
**senior-software-engineer** (implements; gates clean; no tracker edits, no push), **qa-tester** (`QA_REPORT.md`),
**red-team-pentester** (`SECURITY_REPORT.md`). Commands in `.claude/commands/`: `/resume`, `/build-feature`,
`/fix-bug`, `/verify`, `/ship`. Risk tiers decide how much of the pipeline runs; at most 3 fix cycles for a feature
(2 for a bug); trackers are updated at the end; commits only through `/ship`.

Every change is checked against `docs/ENGINEERING_CHECKLIST.md`.

## Official references

[SvelteKit on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/sveltekit/),
[D1](https://developers.cloudflare.com/d1/), [R2](https://developers.cloudflare.com/r2/),
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/),
[Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/),
[SQLite FTS5](https://www.sqlite.org/fts5.html). Re-check official docs before choosing versions or provider calls;
never hard-code guessed pricing, quotas or SDK capabilities.
