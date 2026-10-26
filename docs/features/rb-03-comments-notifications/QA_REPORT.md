# RB-03 QA report

**Verdict: PASS** (one Low/Medium shell defect, F1, non-blocking; engineer-noted deviations accepted).

## Commands run
- `npm ci --prefer-offline --no-audit --no-fund` + `npx svelte-kit sync`: exit 0, local only.
- `npm run gates`: exit 0; svelte-check --fail-on-warnings clean, lint clean, vitest "Test Files 37 passed (37), Tests 743 passed (743)" (local D1 via openLocalD1), build ok (adapter-cloudflare).
- `RUBY_E2E_PORT=4381 npm run test:e2e`: exit 0, "103 passed, 18 skipped" (production build under wrangler dev, local D1 in .wrangler/e2e-state; 402x874, 440x956, 360, desktop). Includes new `e2e/rb03-qa.spec.ts`.
- No migration added (`git diff main..HEAD -- migrations` empty), so `db:reset:local` not needed.

## Criteria
1. Signed out PASS: fetch without cookie: `/api/mentions` 401, `/notifications` redirect, `?/commentCreate` and `/notifications?/readAll` not 200 (rb03-qa.spec.ts raw HTTP); integration "signed out: every comment action ... answer 401".
2. Live task and page PASS; deleted/missing/malformed 404, nothing written: integration "create ... refuses deleted, missing, malformed"; e2e raw POST to `/kb/not-a-uuid`, zero uuid, unknown task all 404.
3. Bounds PASS: raw POST empty, whitespace, NUL-only, 10 001 = 400; 10 000 and 1 = 303 (e2e); unit parseCommentBody.
4. Inert Markdown PASS: stored `<script>`, `<img onerror>`, `javascript:` and `data:` links render as escaped text; zero img/script/javascript: anchors; `window.__x` undefined (e2e).
5. Edit PASS: stale expectedUpdatedAt 409; non-author member 403; admin editing member's comment 403; "edited" label shows after edit; deleted comment edit 404 (e2e + integration).
6. Delete PASS: member deleting admin's comment 403, comment unchanged; admin deletes member's (303), repeat idempotent, comment gone from thread.
7. Mention PASS: integration "a mention of an active user notifies once; self, disabled, unknown, malformed notify nobody"; e2e admin received "Max Member mentioned you ...".
8. Dedup and cap 20 PASS: unit "caps mentions at 20"; integration "more than 20 distinct mentions notify only the first 20".
9. Task assignee/creator PASS: integration fan-out tests (mention wins, author never, pages mention-only).
10. Edit mentions PASS: unit + integration "an edit notifies only newly mentioned ...".
11. Atomicity PASS: integration "failing notification insert leaves no comment" (one db.batch, `INSERT ... SELECT WHERE EXISTS`).
12. Assigned rows and bounded queries PASS: integration "inbox ... RB-01 assigned rows"; "describeNotifications issues a fixed number of queries".
13. Isolation PASS: e2e forged id and member readAll left admin's unread count unchanged; bad id 404; integration "mark read and mark all touch only viewer's rows".
14. Badge PASS: layout unread count (capped 100, "99+" at >=100), hidden at 0 (code `+layout.svelte:33`); integration "layout badge counts up to 100"; e2e badge after mention/mark read (comments.spec.ts).
15. Filter/cursor PASS: integration "filter=unread and a 30-row cursor with equal timestamps: no duplicates, no skips".
16. Links PASS: e2e clicks notification link, lands on `<path>#comment-<uuid>`; deleted comment shows "Comment deleted" (seen in e2e inbox), integration "rows for deleted comment or target render safely".
17. `/api/mentions` PASS: <=8, keys exactly id+name, no email, `cache-control: private, no-store`, q 51 chars 400, q 50 chars 200, `%_'` returns [] (e2e + integration).
18. Throttle PASS: e2e as member: 429 reached within 25 distinct posts, response body contains typed text, comment not written; integration "25 concurrent creates: exactly 20 written".
19. Picker and no-JS PASS: comments.spec.ts (picker with listbox/ARIA, keyboard) and no-JS post/refusal flows pass on all 4 projects; role=listbox markup seen in SSR output.
20. Archived project PASS: integration "comments on a task of an archived project are allowed".
21. Gates PASS, no migration.

Other checks: `requireUser` first in all three actions, both host loads, notifications load/actions, /api/mentions; hidden/forged ids give 404; all timestamps are ms integers; 5xx never seen. Phones 402/440/360: no horizontal overflow, 44 px targets (comments.spec.ts, passing).

## Findings
- **F1 (Low/Medium, shell, not RB-03 code): fixed tab bar covers focused form controls.** `src/routes/(app)/+layout.svelte:280-294` pads `.main` bottom, so a button is reachable at the page bottom (verified: button bottom <= tab bar top at page end on all phones, JS on and off), but the app sets no `scroll-padding-bottom` (`grep scroll-padding src` finds only Board.svelte). Anything scrolled into view by focus lands under the bar. Repro: phone project, open `/kb/<id>/edit` (or a page with the comment form), scroll to top, `Save`/`Comment`.focus() (what Tab/validation focus does). Measured: 402x874 KB edit Save bottom 874 vs bar top 817 (JS on and off), comment button 825 vs 817 (JS on); 440 `/kb/new` Create page 956 vs 899; 360 no-JS comment 780 vs 723. Not a blocker: scrolling the page one screen reveals it, but a Tab-key or no-JS keyboard user can focus an invisible button. Fix suggestion (not applied): `html { scroll-padding-bottom: calc(var(--tabbar-h) + var(--sai-bottom) + 16px); }` below 768 px. Proof: `e2e/rb03-qa.spec.ts` "phones: submit button vs fixed tab bar" (asserts only the page-bottom case, logs focus overlaps).
- **F2 (Info): deviations accepted.** Plain validators instead of zod (repo has no zod; same boundaries tested). Throttle is 20/min plus 200/10 min, edits count. PRD "skeleton while loading" not built: the thread and inbox come with the page data (SSR), so there is no client loading state to show; acceptable.
- Engineering checklist: no violated item found in the diff.

Proof test added: `e2e/rb03-qa.spec.ts`.
