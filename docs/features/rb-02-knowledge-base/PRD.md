# RB-02 Knowledge base and search — PRD

Risk tier: **Large** (page tree with subtree operations, optimistic concurrency + revision history, FTS5 query construction from untrusted text, new `/search` surface).

Depends on: RB-00 (`requireUser`, UI kit, `renderMarkdown`, throttle scope `search`, test helpers). Declared dependency on **RB-01** only for the *concept* of projects and tasks (project-scoped pages hang off `projects`; search links to tasks). **Buildable in parallel with RB-01**: this PRD reads `projects`/`tasks` tables directly through its own queries and seeds them in its own test helper; it imports no RB-01 module and edits no RB-01 file. RB-03 and RB-04 build on this PRD. Schema is fixed: no schema additions.

Route note: nav and CLAUDE.md both use `/kb`; no conflict.

## Goal

A shared, searchable team wiki. Pages are Markdown, arranged in a tree, either team-wide or belonging to one project. Every save is a revision; two people editing at once never silently overwrite each other. One search box finds pages and tasks.

## Owner decisions (defaults accepted 2026-10-26)

1. Any active user may create, edit and move pages. Delete a page (and its subtree): its creator or admin.
2. Max tree depth 8 levels; max 2000 live pages in one tree level is not enforced.
3. Revisions are kept forever (no pruning); identical saves create no revision.
4. Archived projects' pages stay editable (the KB is documentation).
5. Search shows tasks and pages from archived projects, marked "Archived".
6. Throttle `search`: proposed 30 requests/minute/user (value lives in RB-00's scope table).

## Scope

### Routes (under `src/routes/(app)/kb/`; each `load` and action begins with `requireUser`)

| Route | Purpose |
|---|---|
| `kb/+page.*` | Team-wide tree (`project_id IS NULL`) as a nested outline, plus a left/top scope switcher listing active projects (links to `kb/projects/[key]`). Button "New page". Empty: "No pages yet". |
| `kb/projects/[key]/+page.*` | Tree of one project's pages. Unknown key or deleted project: 404. Archived project shows a chip. |
| `kb/new/+page.*` | Create form. Query `?project=<KEY>` (omit = team-wide) and `?parent=<pageId>` preselect scope/parent. Action `default`. |
| `kb/[id]/+page.*` | View: breadcrumbs, title, rendered body, metadata (created by, last edited by/at, `Revision N`), children list, buttons Edit / History / Move / Delete. Slots `<!-- RB-04:attachments -->` and `<!-- RB-03:comments -->` (empty here). |
| `kb/[id]/edit/+page.*` | Editor. Action `save`. |
| `kb/[id]/move/+page.*` | Move form (action `move`): parent select + placement. Works without JS. |
| `kb/[id]/delete/+page.*` | Confirmation page (action `delete`, requires `confirm=yes`). |
| `kb/[id]/history/+page.*` | Revision list, newest first, 50 per page (`?page=`): revision number, title, editor, time, "View", "Compare with current" (stretch: see out of scope), "Restore". |
| `kb/[id]/history/[revision]/+page.*` | Read-only view of one revision (title + rendered body), "Restore this version" form. Param `^[1-9][0-9]{0,8}$` else 404. |
| `search/+page.*` | Search (GET `?q=&type=all|pages|tasks`). |

`:id` params are uuids; anything else is 404 (same as unknown). Deleted pages: 404 for everyone.

### Page structure

- **Tree rendering**: server returns a flat list for one scope ordered `(parent_id, position, title)`; `tree.ts` builds nesting. Max 2000 rows per scope loaded; beyond that the tree stops at depth 3 with a "Show more" link to `kb/[id]` (documented limit). Each node is a link; `<details>` per branch (open for ancestors of current page). Works without JS.
- **Breadcrumbs**: `Knowledge base` (or `Knowledge base / <Project name>`) then each ancestor, via one recursive CTE (`WITH RECURSIVE anc(id,parent_id,title,depth) …`, depth ≤ 8 guard). A soft-deleted ancestor cannot exist because deleting cascades to the subtree.
- **Editor**: Title input; textarea Body with "Write | Preview" tabs. Preview with JS: client-side call of `renderMarkdown`; without JS: button "Preview" submits action `preview` returning the rendered HTML above the form with input preserved. Hidden fields: `expectedRevision` (integer). Save button, Cancel link. Unsaved-changes `beforeunload` guard with JS.
- **Conflict screen** (409 from `save`): banner "This page was changed by <name> while you were editing (now revision N)". Two panels side by side: "Your version" (editable textarea with the user's title/body) and "Current version" (read-only rendered + raw toggle). Buttons: "Save mine over theirs" (resubmits with `expectedRevision = N`, creating revision N+1 with the user's content), "Discard mine" (link to view). No automatic merge.
- **History**: revision rows with editor name; current revision marked "Current". Restore is hidden for the current revision.

### Server modules (`src/lib/server/kb/`, `src/lib/server/search/`)

- `kb/validation.ts` — zod schemas + exported `KB_LIMITS`.
- `kb/tree.ts` — pure: `buildTree(rows)`, `depthOf`, `canMoveUnder` (client/pure checks only; the DB guard is authoritative).
- `kb/repo.ts` — `listScopePages(db, projectId|null)`, `getPage(db, id)`, `getBreadcrumbs(db, id)`, `getChildren(db, id)`, `createPage(db, actor, input)`, `savePage(db, actor, id, input, expectedRevision)`, `movePage(db, actor, id, {parentId, projectId, placement})`, `deletePage(db, actor, id)`, `listRevisions(db, pageId, page)`, `getRevision(db, pageId, revision)`, `restoreRevision(db, actor, pageId, revision, expectedRevision)`, `getProjectByKey(db, key)` and `listActiveProjects(db)` (own small copies; do not import RB-01).
- `kb/permissions.ts` — `canDeletePage(actor, page)`.
- `search/query.ts` — pure: `buildMatchQuery(raw): string | null`, `splitMarkedSnippet(s): Segment[]`.
- `search/repo.ts` — `searchAll(db, rawQuery, { type, limit })` → `{ pages: PageHit[], tasks: TaskHit[] }`.

### Validation

- Page `title`: trimmed, control/zero-width/bidi chars stripped, newlines collapsed to a space, 1–200 chars. `body`: 0–200 000 chars (NUL stripped, `\r\n` → `\n`). `expectedRevision`: integer ≥ 1.
- `parentId`: empty (root of scope) or uuid of a live page. `projectId`/project key: empty (team-wide) or a live project (archived allowed).
- Rules enforced server-side: a child's `project_id` equals its parent's; depth (root = 1) ≤ 8 counting the page's whole subtree height on move; a page cannot be moved under itself or a descendant; `position` placement is `first`, `last` (default) or `after:<siblingId>` where the sibling shares the target parent.
- Search `q`: trimmed, NFKC-normalised, max 200 chars before tokenising (longer → truncated, not an error); `type` ∈ `all|pages|tasks`; empty/too-short (no tokens) → no query run, hint text.

### Concurrency

- **Create**: one `db.batch`: (1) `INSERT INTO pages … SELECT … WHERE (parent null OR EXISTS(live parent in same project_id)) AND (project null OR EXISTS(live project))` with `revision=1`, `position = coalesce(max(position),0)+1024 among siblings`; (2) `INSERT INTO page_revisions (id,page_id,revision,title,body,edited_by,created_at) SELECT … FROM pages WHERE id=:newId` (revision 1 copied from the page row). `changes=0` on (1) → parent vanished/changed, show form error. Depth check is a pre-read (not race-safe; worst case depth 9, harmless).
- **Save** (title/body edit): no-op if title and body equal stored values (redirect, no revision). Else batch:
  1. `UPDATE pages SET title=:t, body=:b, revision=revision+1, updated_by=:u, updated_at=:now WHERE id=:id AND revision=:expected AND deleted_at IS NULL`
  2. `INSERT INTO page_revisions … SELECT id, revision, title, body, updated_by, updated_at FROM pages WHERE id=:id AND revision=:expected+1 AND updated_by=:u AND updated_at=:now`.
  If (1) changes 0, re-read: deleted → 404; else **conflict**. If a racing save made step 2 collide on `page_revisions_page_revision_uq`, the whole batch rolls back (D1 batch is atomic) and the error is mapped to the same conflict result. Never insert a revision row without the matching page update.
- **Restore revision R**: loads revision R, then performs the same guarded save (new revision = current+1, content = R's title/body, `edited_by` = actor) against `expectedRevision` taken from the form (page's current revision at render time); conflict → 409 "Page changed meanwhile, review and retry". Restore never rewrites history.
- **Move**: single guarded `UPDATE pages SET parent_id, project_id, position, updated_at, updated_by` … `WHERE id=:id AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM descendants-CTE of :id WHERE id = :newParent) AND (:newParent IS NULL OR EXISTS (SELECT 1 FROM pages WHERE id=:newParent AND deleted_at IS NULL AND project_id IS :targetProject))`. When the scope changes, the same batch runs a second statement: `WITH RECURSIVE sub(id) AS (…) UPDATE pages SET project_id=:targetProject WHERE id IN (SELECT id FROM sub) AND id <> :id`. A move does **not** create a revision and does not touch `revision`, so it never causes an edit conflict; it bumps `updated_at`. Position: midpoint rule as in tasks (neighbour midpoint; ±1024 at the ends; renumber siblings in one batch if gap < 1e-6).
- **Delete**: one statement `WITH RECURSIVE sub(id) AS (SELECT :id UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id=sub.id WHERE p.deleted_at IS NULL) UPDATE pages SET deleted_at=:now, updated_at=:now WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL`. Idempotent. Requires `canDeletePage` on the root of the deletion only.
- FTS stays in step through the existing triggers (`pages_fts_au` fires on title/body updates). Application code never writes FTS tables.

### Search (`/search`)

- `buildMatchQuery(raw)`: NFKC-normalise; lowercase; split on `[^\p{L}\p{N}]+` (mirrors `unicode61`); drop empty and tokens > 64 chars; keep at most 8 tokens; return `null` if none. Each token is emitted as `"token"*` (double quotes inside a token are impossible after the split but still doubled defensively) joined by a single space (implicit AND). No user text ever reaches MATCH outside quotes, so `AND`, `OR`, `NOT`, `NEAR`, `*`, `-`, `:`, `^`, `(` are inert.
- Queries (bound parameters only):
  - Pages: `SELECT p.id, p.title, p.project_id, p.updated_at, snippet(pages_fts, 1, char(1), char(2), '…', 12) AS snip FROM pages_fts JOIN pages p ON p.rowid = pages_fts.rowid WHERE pages_fts MATCH :m AND p.deleted_at IS NULL ORDER BY bm25(pages_fts, 4.0, 1.0) LIMIT :n`.
  - Tasks: same shape over `tasks_fts` joined to `tasks t` and `projects pr` (for key), `t.deleted_at IS NULL AND pr.deleted_at IS NULL`, `snippet(tasks_fts, 1, …)`, `bm25(tasks_fts, 4.0, 1.0)`.
  - `n` = 25 per type for `type=all` (so ≤ 50 rows), 50 for a single type; hard cap constant in `search/repo.ts`. No offset pagination (bounded top-N; page says "Showing top 25").
  - Identifier shortcut: if `q` matches `^[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,8}$`, additionally look up that task and show it first as "Exact match".
- **Snippet/highlight safety**: SQL emits control chars 0x01/0x02 as markers. `splitMarkedSnippet` splits on them into `{text, hit}` segments after stripping any pre-existing 0x01/0x02 from the source text; the Svelte template renders segments as text nodes (`{seg.text}`) with `<mark>` around hit segments. No `{@html}` anywhere in search results. Titles also rendered as text, with hits highlighted only via the same split on an in-code case-insensitive token match (or left unhighlighted).
- Result row: type icon, title (page: link `/kb/<id>`, task: `KEY-N title` link `/projects/<KEY>/tasks/<N>`), context (page: scope "Team" or project key; task: status chip), snippet, updated time.
- Throttle: after `requireUser`, consume scope `search`; exceeded → 429 page "Too many searches, wait a moment" with `Retry-After`. Empty `q` does not consume throttle.
- FTS5 errors (`fts5: syntax error` should be impossible) are caught, logged via `errorLabel` only (never the query), and rendered as "Search is unavailable, try again".

### Authorization per action

Every action: `requireUser`. Delete: creator or admin. Everything else: any active user. Ids resolved server-side; deleted/missing/malformed → identical 404.

### States

- Loading: tree skeleton lines; search shows "Searching…" via `navigating`; saving buttons disabled with spinner.
- Empty: empty scope ("No pages here yet — create one"); empty history cannot happen (≥ 1 revision); search: initial "Type to search pages and tasks", no results "No results for “…”" (query shown as text), too short "Use at least one letter or number".
- Error: field errors for title/body/parent; 409 conflict screen; 404; 429; storage/DB failure → banner with retry, form content preserved.
- Success: toast after server confirms ("Page saved", "Page moved", "Page deleted", "Restored revision N as N+1").

## Acceptance criteria

1. Signed-out access to every RB-02 route/action is refused per RB-00.
2. Creating a team page and a project page works; both appear in the right tree; page row and `page_revisions` revision 1 exist atomically.
3. Title 0 / 201 chars and body 200 001 chars rejected; 1 / 200 / 200 000 accepted; control/zero-width characters are stripped from titles.
4. Child page cannot be created or moved under a parent in a different scope or under a deleted/missing parent; error is a field error, no row written.
5. Moving a page under itself or any descendant is refused and changes nothing (including via a forged form post).
6. Moving a page with children into another scope updates the whole subtree's `project_id` in one batch; breadcrumbs reflect it.
7. Depth > 8 is refused on create and on move (subtree height counted).
8. Saving with the current `expectedRevision` increments `revision`, adds exactly one revision row with matching title/body/editor; saving unchanged content adds none.
9. Two saves racing from the same revision: exactly one succeeds; the other gets the conflict screen with both versions; no revision gap or duplicate (`page_revisions` revisions are contiguous 1..N).
10. "Save mine over theirs" produces revision N+1 containing the user's content; history shows all three versions.
11. Restore creates a new revision with the old content; refused with a conflict if the page changed since the form rendered.
12. History lists newest first, paginates at 50, marks current; viewing a revision renders it through `renderMarkdown`; revision of another page or revision number 0/abc/999999 → 404.
13. Move changes position/parent without bumping `revision` or creating a revision, and does not conflict with an open editor.
14. Deleting a page tombstones the whole subtree in one statement; deleted pages vanish from tree, breadcrumbs, search and direct URL (404). Non-creator non-admin gets 403.
15. Breadcrumbs show the full ancestor chain, each linking correctly.
16. Search: `foo bar` matches pages/tasks containing both words by prefix (`fo ba` also matches); results exclude deleted rows; ranking puts title matches first; ≤ 25 per type (50 for single type).
17. Hostile queries `"`, `*`, `AND OR NOT`, `a:b`, `NEAR(a b)`, `(`, `-x`, `^x`, 10 000-char strings, emoji-only, only punctuation never throw and never leak FTS errors; token-less input shows the hint.
18. A page body containing `<script>`, `<img onerror>`, and the markers `\u0001`/`\u0002` produces escaped snippets (verified in the DOM test: no element other than `mark` is created from content).
19. `type=pages` / `type=tasks` filter works; invalid `type` falls back to `all`.
20. Exceeding the `search` throttle returns 429 and does not run the query.
21. Task identifier query `OPS-12` shows that task first when it exists.
22. Page view, editor and history work with JS disabled (preview via action).
23. Breadcrumb/tree queries use bound parameters; no string-built SQL from user input except constants.
24. `npm run check`, lint, tests green; no migration added.

## Test plan

Vitest unit: `buildMatchQuery` table (hostile inputs, unicode, accents `é`↔`e`, token caps); `splitMarkedSnippet`; `buildTree`/`canMoveUnder`; validation boundaries; permission helper.
Integration (`openLocalD1`, helper `test/helpers/seed-kb.ts` that inserts users/projects/tasks directly, RB-02 only): create/save/restore revision invariants; 10-way concurrent save race (contiguous revisions); conflict payload; cycle-guard via direct repo call; subtree move and delete; FTS consistency after create, edit, delete (hit disappears via join filter) and restore-as-new-revision; search with real FTS5 including hostile inputs; throttle with `fakeEvent`; breadcrumbs; depth limit.
Manual/browser: conflict screen with two tabs, no-JS editor and move, tree on phone width.

## Out of scope

Comments (RB-03), attachments (RB-04), page restore from deletion (trash UI), diff view between revisions, templates, page duplication, page import/export, per-page permissions, page mentions/backlinks, live co-editing, page watchers/notifications, search filters beyond type, search history, pagination of results, tasks' comment text search, ranking tuning, cross-scope bulk move UI.

## Architecture notes

- Reuse `newId`, `isUniqueViolation`, `errorLabel` (`src/lib/server/util.ts`), `renderMarkdown` (only renderer allowed), kit components, `pages`, `page_revisions`, `pages_fts`, `tasks_fts`.
- Own trees: `src/routes/(app)/kb/**`, `src/routes/(app)/search/**`, `src/lib/server/kb/**`, `src/lib/server/search/**`, `test/helpers/seed-kb.ts`.
- Shared files: **none** with RB-01 (RB-01 holds `projects/**`, `my-tasks/**`, `tasks/**`; RB-02 holds `kb/**`, `search/**`). Cross-links are plain URLs (`/projects/<KEY>/tasks/<N>`, `/kb/projects/<KEY>`). No doc edits needed.
- No prerequisites or secrets.

## Schema additions

None. Existing unique `page_revisions_page_revision_uq`, `pages_project_parent_idx` and FTS triggers cover all queries.
