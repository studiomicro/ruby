# RB-03 Comments, @mentions and notifications — PRD

Risk tier: **Medium** (no schema change; user-text handling and cross-user fan-out; reuses RB-00 Markdown and throttle).

Depends on: **RB-01** (task detail page `/projects/<KEY>/tasks/<N>`, slot `<!-- RB-03:comments -->`, the existing `assigned` notification insert) **and RB-02** (page view `/kb/[id]`, slot `<!-- RB-03:comments -->`). Cannot start until both have merged. RB-00 provides `requireUser`, `renderMarkdown`, `extractMentionIds`, throttle scope `comment-create`.

## Goal

Let people discuss tasks and pages in context, pull colleagues in with @mentions, and find out about things that concern them through an in-app inbox with an unread badge.

## Owner decisions (defaults accepted 2026-10-26)

1. Comment body 1–10 000 chars. Edit own comment any time; delete own comment, admin may delete any. Deleted comments disappear (no placeholder); notifications that referenced them show "comment deleted".
2. "New comment" notifications go to a task's assignee and creator (not page creators; pages notify only via mentions).
3. Pages/tasks of archived projects and soft-deleted targets: comments on a soft-deleted target are refused (404); archived projects still allow comments.
4. No notification retention limit this pass; list shows newest 30 with "Load older".
5. Throttle `comment-create`: proposed 20/minute/user, shared by create and edit.
6. @mention picker needs JS; without JS users still post comments (text mentions are inert).

## Scope

### Shared-file edits (explicit; this PRD edits RB-00/01/02 files)

- `src/routes/(app)/projects/[key]/tasks/[number]/+page.svelte` and `+page.server.ts`: replace the slot with `<CommentThread>` and add its load data/actions (or `export`ed re-use of a shared helper `loadThread`). Also `src/routes/(app)/kb/[id]/+page.svelte` / `+page.server.ts`: same.
- RB-00 shell: `src/routes/(app)/+layout.server.ts` returns `unreadCount`; the shell nav component shows a badge on Notifications (hidden at 0, "99+" above 99).
- Nothing else is shared.

### Routes

| Route | Purpose |
|---|---|
| comment actions on the two host pages | `?/commentCreate`, `?/commentEdit`, `?/commentDelete` (named form actions on the host page's `+page.server.ts`, each a thin wrapper calling `src/lib/server/comments/service.ts`). Works without JS via POST/redirect to `#comment-<id>`. |
| `GET /api/mentions` (`src/routes/api/mentions/+server.ts`) | `requireUser`; `?q=` (0–50 chars) returns up to 8 active users `{id, name}` whose name starts with or contains q (case-insensitive), ordered prefix-first then name; excludes disabled; no emails. JSON, `Cache-Control: private, no-store`. |
| `notifications/+page.*` | Inbox. `?filter=all|unread` (default `all`), cursor `?before=<createdAt>_<id>`. Actions `?/read` (field `id`), `?/readAll`. |

### Page structure

- **Comment thread** (component `src/lib/ui/comments/CommentThread.svelte` + `CommentForm.svelte`): list oldest-first, max 100 per load (`?cpage=` pages of 100), each with avatar initials, author name, relative time (absolute in `title`), "edited" label when `updated_at > created_at`, rendered Markdown via `renderMarkdown`, anchor `id="comment-<id>"`, actions Edit / Delete only where permitted. Form: textarea (label "Add a comment"), Preview tab, character counter, submit "Comment". Mentions render as styled chips (`renderMarkdown` output; the name shown is the text inside the link, never trusted as identity — the id decides).
- **Mention picker** (JS): typing `@` plus ≥ 0 chars in the textarea opens a listbox fed by `/api/mentions` (debounce 150 ms, abort stale requests); arrows/Enter/Tab select, Esc closes; inserts `@[Name](user:<id>)` followed by a space. Name is sanitised (strip `[`, `]`, `(`, `)`, newlines) before insertion.
- **Notifications page**: row = actor name + sentence ("mentioned you in a comment on OPS-12 Fix login" / "commented on OPS-12 …" / "assigned you OPS-12 …" / page variants), excerpt (first 140 chars of comment plain text, rendered as text), relative time, unread dot, link to target with `#comment-<id>` when applicable, per-row "Mark read" button. Header: "Mark all read" button (hidden when none unread). Opening a link with JS also posts mark-read (fire-and-forget) before navigating; without JS use the button.
- **Unread badge**: count of `notifications` rows where `user_id=me AND read_at IS NULL`, computed in the `(app)` layout load (one indexed COUNT, uses `notifications_user_idx`).

### Server modules (`src/lib/server/comments/`, `src/lib/server/notifications/`, `src/lib/server/targets/`)

- `targets/resolve.ts` — `resolveTarget(db, kind, id)` → `{kind, id, title, href, assigneeId?, creatorId, projectKey?}` or `null` when missing/soft-deleted (task: join `projects`; page: live page). Used by comments and notification rendering.
- `comments/validation.ts` — zod: `body` (trimmed, NUL stripped, `\r\n`→`\n`, 1–10 000 chars, not whitespace-only), `targetKind` ∈ `TARGET_KINDS`, `targetId` uuid, `expectedUpdatedAt` integer on edit.
- `comments/service.ts` — `createComment(db, actor, input)`, `editComment(db, actor, commentId, body, expectedUpdatedAt)`, `deleteComment(db, actor, commentId)`, `listComments(db, kind, id, page)`.
- `comments/recipients.ts` — pure `computeRecipients({ mentionIds, activeMentionIds, assigneeId, creatorId, authorId, alreadyNotified })` → `Map<userId, 'mention'|'comment'>`.
- `notifications/repo.ts` — `listNotifications(db, userId, {filter, before, limit})`, `unreadCount(db, userId)`, `markRead(db, userId, id)`, `markAllRead(db, userId)`, `describeNotifications(db, rows)` (batched lookups of actors/targets/comments; no N+1: one IN-query per entity type).

### Rules

- **Mentions**: parsed server-side from the body with `extractMentionIds` (RB-00); ids deduped; only ids of **active** users (one `SELECT id FROM users WHERE id IN (…) AND status='active'`) count; at most 20 mentioned users get notified (rest ignored, comment still saved); unknown/disabled ids stay as inert text. The body is stored as written.
- **Recipients on create**: mentioned users get `mention`; additionally, for a *task* target, the assignee and the creator get `comment` unless already mentioned (mention wins; one notification per user per comment); the author is never a recipient; disabled users never. Pages: mentions only.
- **Recipients on edit**: only users newly mentioned (in new body, not in old body) and not the author get a `mention`; no `comment` notifications on edit; removing a mention deletes nothing.
- **Delete**: soft; existing notifications are kept.
- `notifications` rows: `id=newId()`, `actor_id=author`, `target_kind/id` = the commented task/page, `comment_id`=comment.

### Authorization

| Action | Rule |
|---|---|
| view thread, `/api/mentions`, notifications page | any active user (`requireUser`) |
| create comment | any active user; target must resolve (live task/page) |
| edit comment | author only, comment live; admins cannot edit others' text |
| delete comment | author or admin |
| mark read / mark all | only own rows (`WHERE user_id = :me`); other user's id behaves as not found |

### Concurrency

- **Create**: pre-compute recipients, then one `db.batch([insertComment, ...insertNotifications])`. Each notification is `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM comments WHERE id=:cid)` so none exists without its comment; the comment insert is guarded by `WHERE EXISTS (live target)` via `INSERT … SELECT` (task: `tasks.deleted_at IS NULL`; page: `pages.deleted_at IS NULL`); `changes = 0` → 404 target gone, nothing written.
- **Edit**: `UPDATE comments SET body, updated_at = max(:now, :expected+1) WHERE id AND author_id=:me AND deleted_at IS NULL AND updated_at=:expected`; new-mention notifications batched with `WHERE EXISTS (SELECT 1 FROM comments WHERE id=:cid AND updated_at=:newUpdatedAt)`. 0 changes → re-read: deleted → 404, otherwise 409 with the stored body so the author can retry (rare; same user, two tabs).
- **Delete**: guarded `UPDATE comments SET deleted_at=:now, updated_at=:now WHERE id AND deleted_at IS NULL [AND author_id=:me unless admin]`; idempotent.
- **Mark read**: `UPDATE notifications SET read_at=:now WHERE id=:id AND user_id=:me AND read_at IS NULL`; idempotent. **Mark all**: same with `user_id=:me AND read_at IS NULL`, unbounded by rows but a single statement.
- Duplicate form submits (double click): the form button disables with JS; server tolerance: identical body by the same author on the same target within 5 seconds is treated as a duplicate and returns the existing comment (guard in `createComment` via a pre-read; accepted as best effort).
- Throttle: `comment-create` consumed after validation passes, before the write; 429 keeps the form content.

### States

Thread: skeleton rows while loading; empty "No comments yet — start the discussion"; submit disabled+spinner; error banner preserves text; 429 "You're commenting too fast, wait a moment"; 404 if target deleted mid-typing. Notifications: skeleton; empty "You're all caught up" (unread filter) / "No notifications yet"; rows for removed targets read "This item is no longer available" (still markable read). Success only after the server confirms (comment appears via reload/enhance result).

## Acceptance criteria

1. Signed-out users cannot call any action, `/api/mentions` or `/notifications`.
2. A comment can be posted on a live task and a live page; on soft-deleted/missing/malformed targets it is refused with 404 and nothing is written.
3. Body 0, whitespace-only and 10 001 chars rejected; 1 and 10 000 accepted.
4. Comment bodies are rendered only through `renderMarkdown`; `<script>`, `javascript:` links and raw HTML are inert.
5. Author can edit own comment (stale `expectedUpdatedAt` → 409); nobody else can edit it, including admins; "edited" appears after an edit.
6. Author or admin can delete; a plain member cannot delete someone else's comment (403, unchanged); deleted comments vanish from the thread.
7. Mention `@[Ann](user:<activeId>)` creates exactly one `mention` notification for Ann; mentioning self creates none; disabled/unknown/malformed ids create none and do not fail the save.
8. Same user mentioned three times in one comment gets one notification; more than 20 distinct mentions notify only 20.
9. Commenting on a task notifies assignee and creator with kind `comment`, once each, never the author; a user who is mentioned and also assignee gets only `mention`; page comments notify only mentioned users.
10. Editing to add a new mention notifies only the newly mentioned; editing without new mentions notifies nobody.
11. Comment and its notifications are atomic: forced failure of a notification insert leaves no comment (integration).
12. The `assigned` notifications created by RB-01 show in `/notifications` with correct wording; `describeNotifications` issues a bounded number of queries independent of row count.
13. `/notifications` shows only the viewer's rows; mark read / mark all read never affect another user's rows even with forged ids; both are idempotent.
14. Unread badge matches the number of unread rows, hidden at 0, "99+" over 99, updates after marking read.
15. `?filter=unread` shows only unread; cursor pagination returns 30 per page with no duplicates/skips for equal `created_at`.
16. Notification links go to the correct task/page URL with `#comment-<id>`; a notification for a deleted target/comment renders safely.
17. `/api/mentions` returns ≤ 8 active users, no emails, escapes nothing unsafe (JSON), ignores `q` > 50 chars (400), requires auth.
18. Exceeding `comment-create` throttle returns 429, writes nothing, preserves typed text.
19. Mention picker keyboard operable and ARIA listbox; commenting works without JS (plain post/redirect).
20. Comments on tasks of an archived project are allowed.
21. `check`, lint, tests green; no migration added.

## Test plan

Unit: `computeRecipients` matrix (mention vs assignee/creator precedence, self, disabled, cap 20); body validation boundaries; mention-name sanitiser; excerpt builder; cursor encode/decode.
Integration (`openLocalD1`, `fakeEvent`, RB-03 helper `test/helpers/seed-discussion.ts` building users, a project/task, a page): create/edit/delete permissions per role; atomicity with an injected failing statement; notification fan-out for each recipient rule; edit-adds-mention; mark read isolation between two users; unread count; pagination ties; `describeNotifications` query count; throttle with RB-00 helper; target-gone race.
Manual: picker UX, badge, no-JS flow, phone width.

## Out of scope

Threaded replies, reactions, comment attachments, comment search, e-mail/push notifications, notification preferences/mute, digest, mentions in page bodies/task descriptions, `@here`/team mentions, comment restore, notification deletion, real-time updates (badge refreshes on navigation), page-creator notifications, watchers.

## Architecture notes

Reuse `newId`, `errorLabel`, `renderMarkdown`, `extractMentionIds`, enums `NOTIFICATION_KINDS`/`TARGET_KINDS`, `comments_target_idx`, `notifications_user_idx`. New trees: `src/lib/server/{comments,notifications,targets}/**`, `src/lib/ui/comments/**`, `src/routes/(app)/notifications/**`, `src/routes/api/mentions/**`. Edits to shared files listed above only. The CLAUDE.md line "mentions stored in a join table" does not match the fixed schema; mentions are re-derived from the body on save, and no join table is added.

## Schema additions

None.
