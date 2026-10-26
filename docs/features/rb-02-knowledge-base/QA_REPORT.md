# RB-02 Knowledge base and search: QA report

**Verdict: PASS** (no blocking defects; 2 low-severity notes)

## Commands run
- `npm ci --prefer-offline --no-audit --no-fund && npx svelte-kit sync`: ok (local, no service).
- `npm run gates`: exit 0; check, lint, build clean; vitest `Test Files 23 passed (23)`, `Tests 486 passed (486)` (local D1 via miniflare, no external service).
- `RUBY_E2E_PORT=4331 npm run test:e2e`: exit 0; `43 passed`, `2 skipped` (desktop-only skips in shell.spec.ts), projects iphone-402, iphone-440, phone-360, desktop; local preview build, fixture data.
- `npx vitest run test/qa`: `Tests 3 passed (3)` (QA probes, `test/qa/rb-02-probes.test.ts`, local D1).
- No migration in `git diff main..HEAD -- migrations`, so `db:reset:local` not needed.

## Acceptance criteria
1. Signed-out refused: PASS. kb-routes.test.ts "signed out: every load and action is refused with 401" (all loads and actions); search.test.ts "signed out is refused". Deactivated user: "session no longer resolves".
2. Create team and project page, revision 1 atomic: PASS. kb.test.ts "writes a team page and a project page with revision 1"; createPage is one batch (repo.ts createPage).
3. Length limits and stripping: PASS. validation.test.ts plus QA probe (title 1/200 ok, 201 refused; body 200000 ok, 200001 refused; zero-width and bidi stripped, newline collapsed).
4. Cross-scope or deleted parent: PASS. kb.test.ts "refuses a parent in another scope, a deleted or missing parent..." and move equivalent; field error, no row.
5. Move under self or descendant: PASS. kb.test.ts "refuses itself and any descendant" (direct call) and kb-routes "forged move under a descendant" (unchanged row). SQL guard also in the UPDATE.
6. Subtree scope move and breadcrumbs: PASS. kb.test.ts "moving a subtree into another scope...".
7. Depth 8: PASS. "refuses depth 9" and "counts the subtree height against the depth limit".
8. Save increments, one revision row, no-op: PASS. "a save adds exactly one matching revision; an unchanged save adds none".
9. Racing saves: PASS. "20 concurrent saves from one revision" and same-millisecond variant: one winner, contiguous revisions.
10. Save mine over theirs: PASS. kb.test.ts "stale save is a conflict... N+1"; kb-routes "stale save answers 409 with both versions". Conflict UI present (edit/+page.svelte banner, two panels, raw toggle, Discard mine).
11. Restore: PASS. "restore makes a new revision... refuses a stale form" and route test (409).
12. History: PASS. "history pages at 50, newest first"; revision 0/abc/999999/other page 404 (kb-routes); body rendered via Markdown kit component (no `{@html}` in kb or search routes, grep).
13. Move leaves revision alone: PASS. "changes position and parent without a revision, and an open editor still saves".
14. Delete subtree, 403: PASS. "tombstones the whole subtree in one statement, idempotently"; route test 403 for non-creator, admin allowed; search drops it (search.test.ts FTS consistency).
15. Breadcrumbs: PASS. "breadcrumbs list every ancestor top first"; Breadcrumbs.svelte links.
16. Search semantics: PASS. search.test.ts prefix, title-first ranking, accent folding, deleted exclusion, caps 25/50.
17. Hostile queries: PASS. search.test.ts `hostile` table (`"`, `*`, `AND OR NOT`, `a:b`, `NEAR(a b)`, `(`, `-x`, `^x`, 10k chars, emoji, punctuation) never throw; route hints for token-less input; errors logged by errorLabel only.
18. Snippet escaping: PASS. "a body with <script>, <img onerror> and stray markers produces only <mark> elements"; Highlighted.svelte renders text nodes.
19. type filter: PASS. "invalid type falls back to all; a valid one is kept".
20. Throttle 429: PASS. "over the throttle answers 429 with Retry-After and does not run the query". See finding L1.
21. `OPS-12` exact match first: PASS. "shows a task named by its identifier first".
22. No-JS: PASS. e2e "without JavaScript: create with a server preview, then edit and save" on all 4 projects; move/delete are plain form posts (e2e "move and delete forms fit the screen").
23. Bound parameters: PASS. repo.ts and search/repo.ts bind every user value; only constants (`LIMIT ${size}`, depth numbers) are interpolated.
24. check, lint, tests green; no migration: PASS (gates exit 0; migrations diff empty).

Mobile layout (402x874, 440x956, 360, desktop): PASS. e2e kb.spec.ts (index, page view with tree drawer, editor tabs, move/delete forms, search) green on all four projects, which assert no horizontal overflow.

Other checklist probes: requireUser on every load/action (route test enumerates all); deleted/malformed ids give identical 404; unsaved-changes guard via `beforeNavigate` (PageEditor.svelte:65); slots `<!-- RB-04:attachments -->` and `<!-- RB-03:comments -->` present ([id]/+page.svelte:76-77); timestamps from `now()` (UTC ms); empty, error and conflict states present. Engineer deviations (named actions `create`/`preview`, plain validation functions, throttle 300/10 min) accepted.

## Findings
- **L1 (low)** `src/lib/server/search/repo.ts:19`: throttle is 300 per fixed 10-minute window, not 30/min. A user can run 300 searches in one burst, then is blocked up to 10 minutes. Repro: 300 quick searches then the 301st gets 429 with Retry-After up to 600 s. Cause is RB-00's fixed window; documented by the engineer. No fix required for this PRD.
- **L2 (low)** `src/lib/server/kb/validation.ts` checkBody: body limit uses UTF-16 `length`, title uses code points. 100001 emoji (under 200000 characters) is refused. Boundary tests with ASCII pass.

No defects found at medium or higher severity. QA tests: `test/qa/rb-02-probes.test.ts` (3 passing; no failing proofs needed). No product code changed, nothing committed.
