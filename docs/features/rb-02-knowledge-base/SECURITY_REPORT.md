# RB-02 Knowledge base — Security report (red team, cycle 1)

Scope: `git diff main..HEAD` at `d1649a3` (wip cycle 1, rebased on main `ade9cac`): `src/lib/server/kb/`,
`src/lib/server/search/`, `src/routes/(app)/kb/**`, `src/routes/(app)/search/`, plus the RB-00 pieces they lean on
(`forms.ts`, `csrf.ts`, `hooks.server.ts`, `throttle.ts`, `markdown.ts`, migration `0001_search.sql`).

## Verdict: FAIL

One medium finding (M1: any member can delete any page by moving it under their own page). Everything else on the
attack list held. Low findings are listed so they are tracked.

## Findings

### M1 — medium — Move-then-delete gets around the "creator or admin" delete rule

- **Where:** `src/lib/server/kb/repo.ts:586`: `canDeletePage` is checked on the root of the deletion only. The
  statement at `repo.ts:590` then soft-deletes the whole live subtree. Moving is open to every active user
  (`src/routes/(app)/kb/[id]/move/+page.server.ts:68-98`, owner decision 1).
- **Exploit:** member M wants to delete page V, which member O created.
  1. M creates a scratch page S.
  2. M posts the move form for V: `POST /kb/<V>/move?/move` with `scope=team&parentId=<S>&placement=last`. The
     answer is 303.
  3. M posts `POST /kb/<S>/delete?/delete` with `confirm=yes`. The answer is 303.

  V and all its subpages are now tombstoned. The same two requests can wipe out any whole space: move each root page
  under S, then delete S. There is no restore in the app (PRD › Out of scope: trash UI), so getting the pages back
  needs direct database work. The delete also records no actor (see L3).
- **Proof:** `test/security/rb02-d1.test.ts` › "PROOF M1 (open)". It passes today, so the exploit works. Flip its
  assertions when this is fixed.
- **Fix (needs an owner decision):** pick one.
  - (a) A non-admin may delete a page only if every live page in its subtree was created by them. Otherwise answer
    403 "Contains pages by others; ask an admin". Enforce this in the delete statement itself:
    `… AND NOT EXISTS (SELECT 1 FROM sub JOIN pages … WHERE created_by <> :actor)` when the actor is not an admin.
    The confirmation page should show the reason.
  - (b) Allow a non-admin to move only pages they created, or only into their own subtree.

  Option (a) keeps owner decision 1 as written and closes the hole.

### L1 — low — Concurrent moves can exceed the depth limit of 8

- **Where:** `src/lib/server/kb/repo.ts:512-514`. The depth and height check is a pre-read. The guarded `UPDATE` at
  `repo.ts:530-535` re-checks the cycle, parent and scope rules, but not depth. The PRD accepts this for create
  ("worst case depth 9"), but it says nothing about move. With moves the error adds up: two moves that are each valid
  give depth 4 + 4 + 4.
- **Repro:** chain T has 4 levels, and chains R and S have height 4 each. Run "move S under R4" and "move R under T4"
  at the same time with `Promise.all`. Both answer `moved`, and the deepest page ends up at depth 12. Proof:
  "PROOF L1 (open)" in `rb02-d1.test.ts`. Run one after the other, the second move is refused.
- **Impact:** integrity only. Breadcrumbs stop at depth 10 (`getBreadcrumbs` guard), so the ancestors above that are
  not shown. There is no cycle and no data leak.
- **Fix:** add a depth guard to the move `UPDATE`: an ancestor CTE of `?2` plus the subtree height of `?1`, both at
  most 8. The checklist rule "a read-then-write that depends on state is one guarded statement" asks for this.
  Alternatively, record the accepted risk in the PRD.

### L2 — low — Search cost: one-letter prefixes and a 10-minute burst window

- **Where:**
  - `src/lib/server/search/query.ts:32`: every token, even a single character, becomes a prefix query `"a"*`. The
    index has no `prefix=` option (`migrations/0001_search.sql:4`), so each term scans every index term that starts
    with that letter.
  - `src/lib/server/search/repo.ts:22`: the throttle is 300 per fixed 10-minute window. The PRD asks for 30 a
    minute. A user can send about 300 at once, and about 600 around a window boundary.
- **Measured:** the query `a b c d e f g h` over 300 pages × 2,000 words took ~390 ms on local D1. D1 runs one query
  at a time per database, so a burst of 300 such searches holds the database for about 2 minutes for everyone. For a
  team-sized knowledge base this is small, and the throttle bounds it. Proofs: "the expensive shape …" and "throttle:
  the 301st search …" in `rb02-d1.test.ts`.
- **Fix:** pick any one.
  - Give the prefix `*` only to tokens of 2 or more characters, or only to the last token.
  - Or add `prefix='2 3'` to the FTS tables in a new migration.
  - Or add a short per-minute budget, for example 30 a minute, next to the 10-minute one.

### L3 — low — Delete records no actor

- **Where:** `src/lib/server/kb/repo.ts:590` sets `deleted_at` and `updated_at`, but not `updated_by`. The row keeps
  the name of the last editor or mover, so nothing shows who deleted the page. Together with M1, this makes abuse
  harder to trace.
- **Fix:** add `updated_by = :actor` to the delete statement.

### L4 — low/info — Render cost of large pathological bodies

- **Where:** the shared renderer `src/lib/shared/markdown.ts`. RB-02 is the first feature that stores 200,000-character
  bodies and renders them on every view, on the server and again at hydration.
- **Measured:** `'['.repeat(200000)` takes ~660 ms of CPU per render on an M-series machine, and `*a`×100k takes
  ~200 ms. Under full-suite load, the existing RB-00 timing test (`rb00-pure.test.ts` › "pathological inputs …",
  limit 2 s) failed once in this session, with the run including an earlier version of these probes. It then passed
  in the final run. A user can store such a page on purpose, and every view of it then burns that CPU (Workers CPU
  limit).
- **Fix:** optional. Lower the body cap, or cache rendered HTML per `(page, revision)`. At least note it in the
  RUNBOOK. Consider whether the RB-00 2 s threshold is stable on CI.

### Info (no action needed for security)

- **FTS keeps tombstoned rows.** `CLAUDE.md` says the triggers remove tombstoned rows. Here the triggers fire only on
  `UPDATE OF title, body`, so soft-deleted rows stay indexed. Nothing leaks: both search queries join the base table
  with `deleted_at IS NULL` and filter out deleted projects (`search/repo.ts:96`, `:112`). `snippet()` and
  `highlight()` read the external-content row of a row that is already filtered. Align the doc or the triggers in a
  later migration.
- **Placement is ignored when there are no siblings.** `src/lib/server/kb/tree.ts:120`: `after:<id>` is ignored when
  the target parent has no other children. The page lands at position 1024. This is harmless.

## What held (with evidence)

| Attack | Result | Evidence |
| --- | --- | --- |
| FTS5 MATCH injection: column filters (`title:`, `{title body}:`), `NEAR`, `^`, `AND/OR/NOT`, `*`, parentheses, unbalanced or doubled quotes, NUL, full-width colon (NFKC), SQL fragments | Held: output is always `"tok"*` × at most 8, and real FTS5 never throws or widens results | `rb02-pure` › buildMatchQuery (22 cases and a 5,000-input fuzz); `rb02-d1` › hostile MATCH input |
| DoS bounds: long input, many terms, long terms | Held: input capped at 200 characters (sliced before NFKC), at most 8 tokens, at most 64 characters each, 25/50 rows, no offset | `rb02-pure` › DoS bounds (1 MB input < 200 ms) |
| Snippet and highlight XSS | Held: char(1)/char(2) markers are split into text segments, and `Highlighted.svelte` makes only `<mark>` (no `{@html}`). Page bodies strip the markers on save | `rb02-pure` › snippet highlighting; existing `search.test.ts` |
| Markdown XSS in page body, preview, conflict view and revision view | Held: only `Markdown.svelte` uses `{@html}`, with `html:false` and `isSafeUrl`. Tested `javascript:`, `vbscript:`, `data:`, entity-obfuscated, reference-style, autolink, `//host`, backslash, title-attribute breakout and mention label | `rb02-pure` › 19 payloads, checked for allowed tags and attributes |
| Raw-SQL splicing | Held: every value is bound (`?N`). Only constants (`LIMIT ${max}`, `KB_LIMITS`) are interpolated | code review of `kb/repo.ts` and `search/repo.ts` |
| Signed-out access and a disabled user's session | Held: `requireUser` is first in every load and action. A disabled user's session does not resolve | existing `kb-routes.test.ts` › access |
| Member deletes another member's page directly | Held: 403, row untouched (but see M1) | `rb02-d1` › authorization on delete |
| Admin rules | Held: an admin deletes any page, a creator deletes their own, other members are refused | `rb02-d1` › admin rules |
| Revision IDOR: view or restore page B's revision number through page A | Held: 404, nothing written. `getRevision` is bound to the page id | `rb02-d1` › revision IDOR |
| Forged moves: under self, under a descendant, under a deleted page, cross-scope parent, unknown project, sibling under another parent | Held: 400, row unchanged. The SQL re-checks every rule | `rb02-d1` › forged moves |
| Cycle via concurrent opposite moves | Held: 10 rounds, never a cycle | `rb02-d1` › concurrent opposite moves |
| Cross-project parent on create | Held: 400, no row | `rb02-d1` › creating under a page of another space |
| Lost update or revision race (save + restore mixed, 12 at once) | Held: one write wins, revisions stay contiguous `1,2,3`, and the page row equals the last revision | `rb02-d1` › mixed concurrent saves |
| Soft-deleted leaks: search (pages, tasks, exact `KEY-N`, old revision text), breadcrumbs, children, edit/history/move/delete/revision URLs, `new?parent=<deleted>`, pages of a deleted project | Held: everything hidden or the same 404 | `rb02-d1` › soft-deleted content |
| Body size on edit | Held: over 1 MiB gives 400 before parsing, even when `Content-Length` lies. 200,001 characters gives a field error | `rb02-d1` › body limits |
| Throttle bypass: switching `type`, bogus type | Held: the 301st search gives 429 for every type. The budget is per user. An empty or token-less query is not counted (as the PRD says) | `rb02-d1` › throttle |
| CSRF on every action | Held: the global `isCrossSiteForm` check runs in `hooks.server.ts` before routing and covers multipart, urlencoded, text/plain, and missing or `null` Origin. `readFormBody` refuses other content types with 415 | `rb02-pure` › cross-site form check |
| Open redirects | Held: every post-action redirect is built from a database id or key. `redirectTo` and `next` are ignored | `rb02-d1` › post-action redirects |
| Reflected notice text | Held: `noticeFor` maps to fixed strings, `from`/`to` must be digits, `__proto__` is rejected | `rb02-pure` › notices |
| Cache headers | Held: `hooks.server.ts:73-74` sets `private, no-store` on every signed-in or error response | code review; RB-00 hook tests |
| Logging | Held: a search failure logs only `errorLabel`, never the query. No page text in logs | code review of `search/+page.server.ts:35` |

## Engineering checklist

- "Concurrent writes … one guarded statement": the move depth check does not meet it (L1). Every other write is
  guarded: create, save, restore and delete use `RETURNING id` and a batch, and move re-checks cycle, parent and
  scope in its `UPDATE`.
- "Bounded work": met. Scope rows are capped at 2,001, children at 200, history at 50 per page, search at 25/50,
  recursive CTEs at depth 64 or 10, and projects at 200.
- "MATCH input": met.
- "FTS consistency": met through the join filters (see Info).
- "Revisions": met. The `CLAUDE.md` wording says `updated_at`; the code uses `revision`, which is stronger.
- "One renderer": met.

## Commands

- `npm ci --prefer-offline --no-audit --no-fund` exited 0, then `npx svelte-kit sync` exited 0.
- `npx vitest run test/security/rb02-*.test.ts`: Tests 64 passed (64).
- `npm test`: Test Files 25 passed (25), Tests 550 passed (550), exit 0. An earlier full run had a heavier render
  timing probe that this file later dropped. In that run, `rb00-pure` › "pathological inputs …" and that probe each
  failed once on CPU timing (see L4).
- `npx eslint test/security/rb02-*.test.ts` exited 0. Both files were formatted with Prettier.

Files added: `test/security/rb02-pure.test.ts` and `test/security/rb02-d1.test.ts`. No product code changed. Nothing
committed, pushed or deployed.

## Re-check after cycle 2 (2026-10-26)

Scope: `git show HEAD` at `4997e8b` (wip cycle 2) against M1, L1, L2, L3 above and QA L2, plus the shared
`src/lib/server/auth/throttle.ts` change. New probes: `test/security/rb02-recheck.test.ts` (13 tests).

### Verdict: PASS

M1 is fixed. L1, L2, L3 and QA L2 are fixed. The throttle change does not weaken any RB-00 budget. No new medium or
high findings. L4 stays accepted (render cost, info).

| Item | Result | Evidence |
| --- | --- | --- |
| M1: member deletes a subtree that holds someone else's page | Fixed. `repo.ts:620-631`: the guarded `UPDATE` carries `?4 = 1 OR NOT EXISTS (… sub … created_by <> actor)`. The root is part of `sub`, so the creator rule is also enforced inside the statement. The only subtree check is in the `UPDATE`, so a stale pre-read cannot help | `rb02-d1` › "PROOF M1 (fixed)"; `rb02-recheck` › M1 (5 tests) |
| M1: move into the subtree racing the delete | Held, 30 rounds of `Promise.all([move V under S, delete S])`. V and its child were never tombstoned. Either the move won and the delete was refused, or the delete won and the move was refused because its parent was gone | `rb02-recheck` › "move-into-subtree racing delete …" |
| M1: the confirmation page said yes, then someone moved a page in | Held: the action answers 403 and nothing changes | `rb02-recheck` › "the confirmation said yes …" |
| M1: pages by a since-disabled user, deeper descendants | Held: they still block a member (at any depth). An admin deletes all 3 pages | `rb02-recheck` › "since-disabled user …" |
| M1: deleted subpages, and edits by others | Held: only live pages count. Once an admin removed the foreign subpage, the creator may delete. `savePage` never changes `created_by` (only the INSERT sets it), so editing a page does not change who owns it | `rb02-recheck` › "only live pages count …", "ownership after edits" |
| M1: someone else's root that holds only my pages | Held: `not-creator`, 403 | `rb02-recheck` |
| M1: restore | No undelete path exists in RB-02 (trash UI is out of scope). `restoreRevision` restores a revision of a live page and does not touch `created_by` or `deleted_at` | code review |
| L1: depth inside the move `UPDATE` | Fixed. `repo.ts:535-546` checks the ancestor depth of `?2` plus the live-subtree height of `?1` against `?7 = 8`. In 15 rounds of 3-way concurrent chain moves, the deepest page was at most 8. Exactly 8 is allowed, 9 is refused | `rb02-d1` › "PROOF L1 (fixed)"; `rb02-recheck` › L1 |
| L2: one-character tokens | Fixed. The `*` is added only when the token has more than 1 code point. Full-width, astral (`𝐀`) and CJK one-letter tokens are exact. A combining mark splits the token, so it cannot lengthen a one-letter token | `query.test.ts`; `rb02-recheck` › L2 |
| L2: per-minute cap and `Retry-After` | Fixed. The 31st search in a minute answers 429, and `Retry-After` is the time left in that minute (45 s at mm:15). The 10-minute refusal still gives up to 600. The next minute opens again. The minute key fails closed | `rb02-d1` › throttle; `rb02-recheck` › L2 |
| L3: delete records the actor | Fixed. The delete sets `updated_by = actor` on every row in the subtree, for both the admin and the member path | `rb02-recheck` (asserts `updated_by`) |
| QA L2: body limit in code points | Fixed. 200,000 emoji pass and 200,001 fail. As UTF-8 they take 800 KB, under the 1 MiB form cap with room for the title. Lone surrogates count as one each. CRLF is normalised before counting. Counting 400,000 code points takes well under 500 ms | `validation.test.ts`; `rb02-recheck` › QA L2 |
| QA L2: client-side `maxlength` removed | No security effect. The server checks every body (`checkBody`) and checks the byte cap before parsing | code review |

### Shared throttle (`throttle.ts`): RB-00 budgets are not weakened

- **Separate keys.** The minute key is `${scope}:user:${id}:minute` and cannot collide with any RB-00 key. The scope
  prefixes differ, and user ids are server UUIDs. `sign-in`, `setup`, `invite-accept` and `account-password` still
  call `countAttempt` with the default 10-minute window and their old budgets. Their call sites did not change.
- **Cleanup cannot reset a running window.** The new predicate is `window_start < now - 10 min`. The old one was
  `window_start < floor10(now)`. Both remove a window only once the request's clock has passed the window's end, so
  the new rule deletes a subset of what the old one deleted. A 10-minute row also survives every minute-window
  cleanup during its window, up to its last millisecond. A clock 90 s ahead does not clear it either.
- **Stale rows are harmless.** `client_hash` is the primary key. The `UPDATE` matches only the current
  `window_start`, and the upsert resets the count when it finds an older row. A stale row therefore cannot carry an
  old count forward.
- **Fail-closed is kept.** `overUserMinuteLimit` wraps the count in `failClosed`. The search route then answers 429.
- **Table growth is bounded.** There is one row per key, and rows older than 10 minutes are removed on the next first
  attempt of any key. In the probe, 30 minutes of search left 2 rows for the user, and after a late first attempt only
  1 row was left. The extra cleanup `DELETE` runs at most once per user per minute and uses `auth_attempts_window_idx`.

  Evidence: `rb02-recheck` › "shared throttle …" (2 tests), and the existing `throttle.test.ts`.

### New findings

None at low or higher. Info only:

- **Fixed-window bursts.** The per-minute window is fixed, so up to 60 searches can land in about 2 s across a minute
  boundary. Two-character prefixes (`"th"*`) still scan by prefix. Both are bounded by 30 a minute and 300 per
  10 minutes. This is acceptable for team size.
- **Create depth is still a pre-read** (the PRD accepts a worst case of depth 9). Now that moves are guarded, a
  create racing a move can add at most one level, so the worst case stays at depth 9.
- **Disabled users' pages need an admin.** A member cannot delete a subtree that holds a disabled user's page. This
  is by design, and the confirmation page says so.

### Commands (re-check)

- `npx svelte-kit sync` exited 0.
- `npx vitest run test/security/rb02-recheck.test.ts`: Tests 13 passed (13).
- `npx eslint test/security/rb02-recheck.test.ts` exited 0. `npm run check`: 0 errors, 0 warnings.
- `npm test`: Test Files 27 passed (27), Tests 575 passed (575), exit 0. That run included an earlier version of the
  probe file. Its last edit removed two unused object fields; the file was then re-run alone and passed 13/13.

Files added: `test/security/rb02-recheck.test.ts`. This report was appended to. No product code changed. Nothing
committed, pushed or deployed.
