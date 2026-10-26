# RB-03 Comments, @mentions and notifications — Security report (red team, cycle 1)

Scope: `git diff main..HEAD` at `dba5f6a` (wip cycle 1): `src/lib/server/{targets,comments,notifications}/`,
`src/lib/ui/comments/`, `src/routes/(app)/notifications/`, `src/routes/api/mentions/+server.ts`, and the edits to the
task page, `kb/[id]` page and `(app)/+layout.server.ts`. Also read the RB-00 pieces they lean on: `guards.ts`,
`csrf.ts`, `forms.ts`, `hooks.server.ts`, `auth/throttle.ts`, `auth/users.ts` (`mentionNames`), `shared/markdown.ts`.

## Verdict: FAIL

One medium finding: M1. A comment on a soft-deleted task, page or project still shows its text in the recipient's
inbox. Two low findings are tracked. Everything else on the attack list held (see "What held").

## Findings

### M1 — medium — Notification excerpts leak comments of soft-deleted targets

- **Where:** `src/lib/server/notifications/repo.ts:183` and `:195`. `commentLive` checks only `comments.deleted_at`.
  The excerpt is therefore built whenever the comment row is live, even when `resolveTargets` found no live target.
  Deleting a task, a page or a project does not tombstone its comments, so their comments stay "live" here.
- **Scenario:** a member posts a credential or other sensitive text in a comment on task T and mentions B. Someone
  deletes T, or its whole project, to remove it. The thread is no longer reachable and B's row reads "This item is
  no longer available". Below that line, B's inbox still shows the first 140 characters of the comment, for as long
  as the notification exists. Notifications cannot be deleted (PRD › Out of scope). The same happens for the
  assignee's and creator's `comment` rows, and for a deleted page. This breaks the tombstone rule of
  `docs/ENGINEERING_CHECKLIST.md` ("every live-data query filters `deleted_at IS NULL`, including … notifications").
  It also breaks the brief's soft-delete rule for notifications.
- **Repro:** `test/security/rb03-d1.test.ts` › "PROOF M1 (open): a comment on a soft-deleted task keeps showing its
  excerpt in the inbox", and "… the same holds for a deleted page and for a task of a deleted project". Both pass
  today, so the leak is real.
- **Fix:** build the excerpt only when the target is live too. For example:
  `const commentLive = target !== undefined && comment !== undefined && comment.deletedAt === null;`
  Keep `commentDeleted` as it is, or show the "no longer available" text only. Also leave the comments of dead
  targets out of the `mentionNames` lookup. Flip the PROOF M1 assertions to `excerpt: null` and add the deleted-project
  case to the integration test at `test/integration/comments.test.ts:489`. That test checks `href` and `targetTitle`
  of the "gone" row but not its `excerpt`.

### L1 — low — An edit loop re-notifies the same people on every cycle

- **Where:** `src/lib/server/comments/service.ts:191`. `alreadyNotified` holds only the mentions of the body being
  replaced, not everyone this comment has already notified.
- **Scenario:** the author edits a mention of B out of the comment, then back in, and repeats. Every re-add sends B a
  new `mention` notification for the same comment. With 20 mentions per body, each pair of edits notifies the same
  20 people again. The shared `comment-create` budget caps this at 20 writes per minute and 200 per 10 minutes. That
  is the same order as posting new comments, so this adds no amplification. It still lets one comment ping people
  repeatedly. The code follows PRD › "Recipients on edit" literally.
- **Repro:** `test/security/rb03-d1.test.ts` › "PROOF L1 (open)". One comment and three toggles give B 4
  notifications.
- **Fix (optional, owner call):** in the edit batch, skip recipients who already have a notification for this
  `comment_id`. For example, add `AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.comment_id = ?7 AND
  n.user_id = u.id)` to the edit-path insert.

### L2 — low — `/api/mentions` has no rate limit

- **Where:** `src/routes/api/mentions/+server.ts:12-16`.
- **Scenario:** any signed-in member can call the API without limit. Each call is one bounded scan of `users` that
  returns 8 rows. This exposes nothing new: every active user's name and id is already in the task page's people
  options. On a one-team users table, the extra load is negligible. Track it for when the picker gets a throttle
  scope.
- **Fix (optional):** a per-user minute budget, like `search`'s, with 429 past it.

### Informational (not counted)

- `mentionNames` (`src/lib/server/auth/users.ts:57`, RB-00 code, not this diff) also returns the names of disabled
  users. A mention of a deactivated user therefore renders as a chip with their name. The checklist line "unknown or
  deactivated names stay plain text" reads stricter than that. This shows no content and identifies no one wrongly,
  because the name is real and comes from the id. It is an RB-00/RB-01 decision that the owner may want to confirm.
- `parseCommentBody` (`src/lib/server/comments/validation.ts:51`) cuts the raw text to 40 001 UTF-16 units before
  cleaning. From reading the code: a body padded with more than about 30 000 control characters could be stored cut
  short, not refused. Only the author's own text is affected. Not run as a test.

## What held (with proof)

`test/security/rb03-d1.test.ts` and `test/security/rb03-pure.test.ts` (49 tests):

- **Authz:** every comment action, `/api/mentions`, the inbox and its two actions call `requireUser` first. A
  disabled user's session resolves to no user (RB-00), which gives 401. A member editing or deleting another user's
  comment gets 403 and the row is unchanged; an upper-case id is no bypass. An admin cannot edit others' text but
  can delete it. A 409 conflict body reaches the author only, because the 403 check comes before any stored text is
  read.
- **IDOR:** a comment id from another target gives 404 through either host and nothing changes. Every write and read
  is scoped by `target_kind` and `target_id`. A task id posted as a page, or the reverse, is refused. A target of a
  soft-deleted page or project takes no create and no edit (guarded `INSERT … SELECT` and `UPDATE`). Mark read and
  mark all read change only the caller's rows (`user_id = :me`). The inbox load ignores user-id query parameters.
- **`/api/mentions`:** returns active users only, `{id, name}` only (no e-mail; searching for `@example.test` finds
  nothing), at most 8, and `private, no-store`. `q` is literal (`instr`, so `%` and `_` are not wildcards), and
  SQL-looking input is bound. More than 50 code points gives 400. The response is a JSON object, not a top-level
  array, and a GET changes no state.
- **Mention spoofing:** `@[Ada Admin](user:<Bo>)` renders `@Bo Bystander`, in the thread and in the excerpt. An
  unknown id renders `@unknown user`. A name made of markup is escaped. A hostile picker name cannot break out of the
  token (`sanitizeMentionName`).
- **Spam:** 60 distinct real mentions notify exactly 20. Self, disabled and unknown ids notify no one. Mention takes
  precedence over comment.
- **XSS:** `<script>`, `<img onerror>`, `javascript:`, `vbscript:` and `data:` links and images, entity-encoded,
  mixed-case and `%0a` variants, reference-style links, autolinks, protocol-relative and backslash URLs, and a mention
  nested in a link all render inert. Excerpts are plain text and rendered with `{text}`. The only `{@html}` is
  `Markdown.svelte` on `renderMarkdown` output.
- **Races and throttle:** two concurrent edits of the same version give exactly 1 ok and 1 conflict. 25 concurrent
  creates give exactly 20 ok and 5 throttled. Create and edit share the budget.
- **Caps:** a form over 128 KiB gives 400 and nothing is written. 10 001 astral code points are refused. The
  delete and inbox forms use the 8 KiB default.
- **CSRF:** cross-site, Origin-less and `text/plain` form posts are refused by the hook rule. A JSON content type,
  which skips that rule, gets 415 from `readFormBody`.
- **Open redirects:** the mark-read and delete redirects are rebuilt from parsed values. `//evil`, CRLF and junk
  cursors all land on `/notifications` or the host path. Notification `href`s are built by the server from live
  targets.
- **Cache:** signed-in pages get `private, no-store` from the hook. The API sets it itself.

## Commands

- `npx vitest run test/security/rb03-pure.test.ts test/security/rb03-d1.test.ts` → `Tests  49 passed (49)`
- `npm test` → `Test Files  39 passed (39)`, `Tests  792 passed (792)` (exit 0; run before the final prettier pass,
  and the proofs were run again after it, 49/49)
- `npx eslint test/security/rb03-*.test.ts` → clean; `npx svelte-check` → `0 ERRORS 0 WARNINGS`

## Re-check after cycle 2 (2026-10-26)

Scope: `git show HEAD` (`6d802e5`, wip cycle 2), checked against the cycle-1 findings above. New probes are in
`test/security/rb03-cycle2.test.ts` (12 tests, not committed). The cycle-1 PROOF tests in `rb03-d1.test.ts` now
assert the fixed behaviour.

### Verdict: PASS

M1, L1 and L2 are fixed. The cap and deactivated-name changes hold. No new medium or high finding. One informational
note is below.

### M1 (medium): fixed

- `src/lib/server/notifications/repo.ts:163-176` now selects only comments whose task or page is live
  (`liveTargetSql`, which checks the project too). `:190` also drops the comment when `resolveTargets` found no live
  target. So two separate checks would both have to fail before an excerpt leaked.
- Probes, all held:
  - **Nested pages:** deleting a grandchild hides only its excerpt. Deleting the parent hides the child's and the
    grandchild's excerpts too, because `deletePage` tombstones the whole live subtree in one statement. Those rows
    read `excerpt: null, href: null, targetTitle: null, commentDeleted: false`.
  - **Deleted project with a page tree:** the excerpts of its root and leaf pages disappear. An archived project
    still shows them, as owner decision 3 requires.
  - **Revisions:** restoring a revision of a live page keeps the excerpt. After the page is deleted,
    `restoreRevision` answers `not-found`, `getPage` is null and no excerpt shows. No undelete path exists in `src/`.
  - **Task moved between states:** moving through `in_progress`, `done` and `todo` keeps the excerpt. After
    `deleteTask`, none shows, including in the assignee's and creator's `comment` rows.
- `mentionNames` is now passed only the bodies of live targets' comments, because the map is already filtered.

### L1 (low): fixed

- `src/lib/server/comments/service.ts:74-75`: each insert is guarded with
  `NOT EXISTS (… n.comment_id = ?7 AND n.user_id = u.id AND n.kind = ?3)`.
- **Race:** five concurrent edits from one version, each re-adding the mention, give one `ok` and one notification.
  D1 runs statements one at a time, so the guard sees every earlier commit.
- **Edits by a different author:** neither an admin nor another member can edit (`forbidden`), so neither can
  re-trigger a mention.
- **Info:** the dedupe works per kind. Say a task's assignee got a `comment` row, and the author later edits in
  `@assignee`. The assignee then also gets a `mention` row, which makes two rows for one comment. This happens at most
  once per user per comment and carries no loop, so it is not counted as a finding. It is documented as the INFO
  test.

### L2 (low): fixed

- `src/routes/api/mentions/+server.ts:20-41` throttles each user with the key
  `mention-search:user:<id>:minute`, 60 lookups per minute.
- Lookup 61 gets 429 with `Retry-After` between 1 and 60, `private, no-store`, and a JSON error.
- Budgets stay separate:
  - A second user still gets 200.
  - The same user can still create a comment, because `comment-create` is a separate key.
- **Fails closed:** a `Db` whose every access throws gives 429 (`failClosed`), never an unthrottled lookup.
- The over-length `q` check (400) runs before the counter does. It touches no database, so it is not a bypass.

### Raw body cap: holds

`src/lib/server/comments/validation.ts:45` refuses a body over 40 000 UTF-16 units before `cleanBody`. Probes:

- 10 000 astral characters plus 20 000 control characters (exactly 40 000 units) are cleaned to the 10 000 astral
  characters. One more unit is refused, so a body is never cut.
- 10 001 and 20 000 astral characters are refused.
- 13 333 `ä\r\n` plus `x` (40 000 units) is refused on code points after cleaning.
- Text that ends at 40 000 units in a lone high surrogate or a split astral character is refused.
- 9 999 `é` plus 1 astral character is accepted unchanged.
- `actions.ts:36` still slices, but only the echo of the refused text shown back in the form, never the stored body.

### `markDeactivated`: holds

- `src/lib/server/auth/users.ts:49-72`: the option defaults to off.
- Callers:
  - `loadThread` passes the flag: the thread's names map gives `Dee Disabled (deactivated)`.
  - `describeNotifications` passes the flag.
  - The task description loader (`projects/[key]/tasks/[number]/+page.server.ts:45`) does not pass it and gets the
    plain name, as before.
- Names still render escaped through `renderMarkdown` and `{text}` excerpts. The only cosmetic oddity is that an active
  user could name themselves "X (deactivated)". That is not a security issue.

### Shared files: no security impact

- **`app.css`:** the cycle adds `scroll-padding-*` in a `max-width: 767px` media query, and `CommentThread.svelte`
  drops one `scroll-margin-top`. These are layout only, with no content, CSP or `{@html}` change.
- **`throttle.ts`:** the only change is `'mention-search'` added to `THROTTLE_SCOPES`, plus its doc comment. RB-00
  budgets are unchanged: `THROTTLE_WINDOW_MS`, `THROTTLE_MAX_ATTEMPTS = 20`, `CLIENT_MAX_ATTEMPTS = 100`,
  `THROTTLE_MINUTE_MS`, `countAttempt` and the `failClosed` paths. No other `src/lib/server/auth/` file changed
  except `users.ts`.

### Commands

- `npx vitest run test/security/rb03-cycle2.test.ts` gave `Tests  12 passed (12)`.
- `npx eslint test/security/rb03-cycle2.test.ts` was clean. The file was formatted with `prettier --write`.
- `npm test` gave `Test Files  40 passed (40)` and `Tests  809 passed (809)`.
