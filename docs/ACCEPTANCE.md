# RUBY — Acceptance Status

Updated 2026-10-26. Legend: **Pass** = verified against the real Cloudflare runtime with the listed check.
**Automated** = Vitest against local D1. **Mocked** = a dependency replaced by a fake. **Not run** = not yet
verified. Evidence: `docs/HISTORY.md` → Test evidence log.

## Required journey

| Step                                                                                    | Status  | Check |
| --------------------------------------------------------------------------------------- | ------- | ----- |
| Behind Access, open `/setup` on an empty database, create the first admin               | Not run |       |
| Request without a valid Access JWT on a deployed host is refused                        | Not run |       |
| Admin invites a member; member accepts the invite once; second use of the link fails    | Not run |       |
| Member cannot open `/admin/users`; deactivated user is signed out at once               | Not run |       |
| Create a project and tasks; move a task on the board; reload keeps the state            | Not run |       |
| Create nested pages; edit; revision list; restore an old revision                       | Not run |       |
| Search finds a page and a task; a deleted one disappears; a restored one returns        | Not run |       |
| Markdown with script, event handlers and `javascript:` links renders inert              | Not run |       |
| Comment with @mention creates a notification for that user only                         | Not run |       |
| Attach a file; download as signed-in user; signed-out download refused; 20 MB cap holds | Not run |       |
| `npm run deploy` records a bookmark, migrates, deploys; rollback steps work             | Not run |       |
