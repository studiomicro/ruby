# RUBY — Task Tracker

Last updated: 2026-10-26.
The **To do** checklist is the source of truth for open work. When an item is done, tick it, then move it with its
evidence to `docs/HISTORY.md`. Mark each item **Claude** (agent work) or **You** (owner action in Cloudflare or a
decision).

## Status summary

RB-00 foundation, RB-01 projects and tasks and RB-02 knowledge base complete and live behind Cloudflare Access. RB-03 comments and notifications live. RB-04 attachments live; RB-05 employee directory live (sensitive fields wait for HR_DATA_KEY); RB-08 PM extras live; RB-06 time off live (v0.3.0); RB-07 onboarding next.

## To do

- [x] **Claude** — RB-00 Foundation: invite-only auth (`/setup`, login, invites, sessions), Cloudflare Access JWT check that fails closed, app shell and navigation, UI kit, Markdown renderer, `requireUser`/`requireAdmin`, admin user management.
- [x] **Claude** — RB-01 Projects and tasks: projects, tasks with status, assignee, due date and priority, list view and board view, soft delete and restore, `tasks_fts` search.
- [x] **Claude** — RB-02 Knowledge base: page tree, Markdown editor and preview, revisions with restore, soft delete, `pages_fts` search and the `/search` page.
- [x] **Claude** — RB-03 Comments, @mentions and notifications: comments on tasks and pages, mention parsing to user ids, in-app notification list with read state.
- [x] **Claude** — RB-04 Attachments: upload to R2 `FILES` from tasks and pages, authorised download route, size and type rules, cleanup on delete.
- [x] **You** — Create D1 `ruby` and R2 `ruby-files`, put the D1 id in `wrangler.jsonc` (`docs/RUNBOOK.md` steps 1–3).
- [x] **You** — Set up the Cloudflare Access application for the app host and set `RUBY_ACCESS_AUD` and `RUBY_ACCESS_TEAM_DOMAIN` in `.deploy.env` (`docs/RUNBOOK.md` step 4).
- [ ] **You** — Let your own sign-in through Access (the `ruby` policy allows only the company e-mail domain; add your address or a One-time PIN login), then open `/setup` to create the first admin (`docs/RUNBOOK.md` steps 5–6). First deploy done.

- [ ] **Claude** — RB-04 follow-ups (Low): N1 multipart parser CPU with 1-byte chunks (avoid per-read timer re-arm and buffer copy); R1 ~5 MiB per upload × parallel uploads vs the 128 MB isolate (cap concurrent uploads per isolate). See `docs/features/rb-04-attachments/SECURITY_REPORT.md` re-check.

- [ ] **You** — Set the HR encryption key: generate 32 random bytes base64url, store it in your password manager, then `npx wrangler secret put HR_DATA_KEY` (docs/RUNBOOK.md › HR data key). Then grant yourself HR in Admin › Users.

- [ ] **Claude** — UI polish: the project board page shows the List/Board switch twice (tabs and segmented control); keep one.

- [ ] **You** — Enter the 2026–2027 public holidays in Time off › Settings (HR).

## Deploy log

Not kept in the repository (the repository is public). Deploy details, including the D1 Time Travel bookmark, are
printed by `npm run deploy` and recorded by the owner outside the repo; see `docs/RUNBOOK.md` › Routine deploy.
