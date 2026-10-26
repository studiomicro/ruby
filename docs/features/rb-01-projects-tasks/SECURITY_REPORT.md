# RB-01 Projects and tasks — Security report (red team, cycle 1)

Scope: `git diff main..HEAD` at `0e0f1c0` (server `src/lib/server/projects/`, `src/lib/server/tasks/`, UI
`src/lib/ui/tasks/`, routes `src/routes/(app)/projects/**` and `src/routes/(app)/my-tasks/**`), checked against
the PRD and `docs/ENGINEERING_CHECKLIST.md`. No product code was changed.

## Verdict: PASS

No medium or high findings. There are four low findings (L1–L4). They are listed below so they can be tracked.
L3 must be closed before RB-02 ships search.

## Findings

### L1 (low): forged mention labels in task descriptions

- **Where:** `src/routes/(app)/projects/[key]/tasks/[number]/+page.svelte:146` renders
  `<Markdown source={data.task.description} …>` without `names`. The load at `+page.server.ts:30-64` does not call
  `mentionNames`.
- **Exploit:** a member writes `@[Ada Admin (CEO)](user:<any uuid>)` in a description. The task page shows a
  mention chip that reads "@Ada Admin (CEO)". RB-00 fixed this case for other bodies, where the stored id decides
  the name, not the label the author typed. Task descriptions miss that fix, so a user can pose as someone else in
  styled text.
- **Repro:** `test/security/rb01-d1.test.ts` › "PROOF L1".
- **Fix:** in the detail load, compute `mentionNames(db, extractMentionIds(task.description))` and pass it as
  `names` to `<Markdown>`. Flip the PROOF test to expect the real name, or `@unknown user`.

### L2 (low): no rate limit on `assigned` notifications

- **Where:** `src/lib/server/tasks/repo.ts:457-468` and `src/lib/server/tasks/assign-notification.ts:12-40`.
- **Exploit:** any active user can patch `assigneeId` back and forth (victim, then self). Each round inserts a new
  `assigned` row for the victim. The PRD allows this ("A→B→A creates a new row each time"), and `actor_id` records
  who did it. Still, a script can flood one colleague's notification list without limit (RB-03 shows these rows).
  The disabled-user, self-assign, unassign and no-change guards all hold.
- **Repro:** `rb01-d1.test.ts` › "PROOF L2": 100 patch requests insert 50 rows for one user.
- **Fix (optional, owner call):** skip the insert when the same `(user_id, actor_id, target_id, kind='assigned')`
  row is still unread, or was written in the last N minutes. Use a `NOT EXISTS` clause inside the same guarded
  `INSERT … SELECT`.

### L3 (low, latent): soft-deleted tasks stay in `tasks_fts`

- **Where:** `migrations/0001_search.sql:29` (the `tasks_fts_au` trigger fires only `AFTER UPDATE OF title,
  description`) and `src/lib/server/tasks/repo.ts:664-684` (`deleteTask` sets only `deleted_at`).
- **Exploit:** after a delete, the task's title and description are still in the FTS index. Today nothing reads
  `tasks_fts`, so nothing leaks. But CLAUDE.md says "Tombstoned pages and tasks are removed from the FTS tables by
  the same triggers", and the checklist says a search after a soft delete must return only live rows. When RB-02
  adds search, any query that does not join `tasks` with `deleted_at IS NULL` will leak deleted titles and
  snippets.
- **Repro:** `rb01-d1.test.ts` › "PROOF L3": `MATCH 'zebraquartz'` still returns 1 row after the delete.
- **Fix:** RB-02 adds a migration whose triggers handle `deleted_at` (delete the row from FTS when the task is
  tombstoned, insert it again on restore). Alternatively, the one search module always joins live rows. RB-02 must
  test both.

### L4 (low): column renumber is not guarded by the archive state

- **Where:** `src/lib/server/tasks/repo.ts:579-584` and `:612-613`.
- **Issue:** `renumberColumn` runs before the guarded move UPDATE, and its own statement does not check that the
  project is active. If the project is archived between the `projectRefusal` read and the renumber, the positions
  in an archived column are rewritten. The move itself is still refused, and the order of the cards is kept.
  Nothing leaks and no content changes. Only the "frozen" promise is broken, for positions.
- **Fix:** add `and exists (select 1 from projects p where p.id = ${projectId} and p.status = 'active' and
  p.deleted_at is null)` to the renumber UPDATE.

### Informational (no action needed)

- `deleteTask` (`repo.ts:664`) checks `canDeleteTask` in the route against a fresh read, not inside the SQL. The only
  race is a lead change at the same moment. Accepted.
- Descriptions are capped by UTF-16 length (`tasks/validation.ts:104`) and titles by code points. The two rules
  differ, but neither is a safety problem: the body cap of 256 KiB holds either way.
- Markdown render time on pathological 20 000-character inputs (deep brackets, emphasis runs, nesting, link floods)
  stayed under 140 ms locally. It is not a DoS risk under the Workers Paid CPU limit.

## Probes that held (proof tests in `test/security/rb01-d1.test.ts` and `test/security/rb01-board.test.ts`)

- **Authorization:** signed-out access gives 401 (the QA matrix). A disabled user's live session is dropped in the
  hook, so the move action never runs. On settings update, archive and unarchive, a member gets 403 and nothing
  changes; lead, creator and admin are allowed. The SQL guard `mayManage` refuses a non-manager even when the route
  check is skipped. Delete gets 403 for a member and for a project creator who is not the lead; the task's creator,
  the lead and an admin may delete. A posted `key` is ignored on edit.
- **CSRF:** a cross-site or `Origin: null` POST to `?/delete` gets 403 in the hook before routing (global
  `isCrossSiteForm`). Every RB-01 mutation is a POST action.
- **IDOR:**
  - A move with a `taskId` from another project gets 404 and changes nothing.
  - An `afterTaskId` from another project, another column or the task itself, or an unknown one, puts the card at
    the bottom.
  - A disabled or nonexistent assignee on create, patch or update gets 400, with no notification.
  - A disabled or nonexistent `leadId` on project create or edit gets 400.
- **Archived freeze:** create, update, patch, delete and move get 409 and leave the row byte-identical. If the
  project is archived between the route's read and the write, the SQL `projectActive` guard still refuses it, and
  no notification is written.
- **Concurrency:**
  - 20 concurrent creates get numbers 1..20, and the counter ends at 21.
  - Two concurrent reassignments from the same version: one wins and exactly one notification is written, to the
    winner.
  - A move after a delete gets 404, and the task is not brought back.
  - A stale or future `expectedUpdatedAt` gets 409. A malformed or unsafe one gets 400.
- **Notifications:** self-assign, unassign and an unchanged assignee insert nothing. An assignee who was disabled
  later is kept on edit, and nobody is notified.
- **Keys and routes:**
  - `new`, `NEW` and `New` are reserved.
  - Cyrillic and fullwidth lookalikes, zero-width and NUL characters, and duplicates in any case are refused.
  - A malformed key in the URL gets 404.
  - The case redirect stays under `/projects/<KEY>/` for `//evil.example`, `%2F%2F` and `..%2F` paths.
  - Task numbers `0`, `01`, `abc`, an 11-digit number, `-1`, `1e2`, `1.0` and ` 1` get 404.
- **Query parameters:** 5 000 or more `status` values, SQL fragments in `status`, `priority`, `assignee`, `sort`
  and `dir`, and `page=99999999999` are all dropped or clamped. The lists are bound once through `json_each`, and
  sort and direction are whitelisted.
- **Body caps:** a 300 KiB body gets 400 (not 500) on task create, update, patch and project create. A 9 KiB move
  body gets 400. A 20 001-character description gets a field error.
- **Markdown XSS:** 15 vectors render inert through `renderMarkdown`: `<script>`, `onerror`, `javascript:` in mixed
  case, entity-encoded and with a tab, `vbscript:`, `data:` links and SVG, reference-style links, autolinks, `//`,
  backslashes, and HTML inside link text. The only `{@html}` is `#lib/ui/kit/Markdown.svelte`. Titles, toasts and
  banners are plain text. `?deleted=` is shown only when it matches `KEY-N`.
- **Soft delete:** a deleted task is gone from the list (rows and total), the board count, the project open count,
  My tasks and its detail page (404). Its number is not reused.
- **Board positions:**
  - 400 alternating midpoint drops into one gap keep positions finite, distinct and in order, because the renumber
    runs below the 1e-6 gap.
  - Top and bottom churn moves positions by only 1024 per move.
  - Tied positions, as from concurrent drops, are renumbered and do not collide.
  - `positionBetween` gives no NaN and no midpoint outside its neighbours near 1e15 or `MAX_SAFE_INTEGER`.
  - No user input ever sets a position.
- **Cache and headers:** signed-in responses get `private, no-store` from the RB-00 hook, which is unchanged in
  this diff.
- **Redirects:** every redirect after an action is built from the stored key and number (`taskPath`,
  `/projects/${key}`). None comes from user input, so there is no open redirect.
- **Page data:** user lists are mapped to `{id, name}` only, with no e-mail addresses, hashes or tokens.

## Commands

- `npx vitest run test/security/rb01-*.test.ts`: Test Files 2 passed (2), Tests 31 passed (31).
- `npm test`: Test Files 23 passed (23), Tests 481 passed (481).
- `npx eslint test/security/rb01-*.test.ts`: exit 0. `npx prettier --check test/security/rb01-*.test.ts`: clean.
  `tsc --noEmit` shows no errors in the rb01 test files.
