# RB-11 Release notes and reload on update — PRD

Risk tier: **Medium** (new read-only page, client-side shell component, deploy-script guard; no schema, no new
authorisation surface, no remote change).

## Goal

Staff can see what changed in each version of Ruby, and a browser that has Ruby open learns when a new version is
deployed and can reload without losing work.

## Owner request (2026-10-26)

"add release notes and reload function".

## Scope

1. **Release notes.** One Markdown file per version in `src/lib/content/releases/<version>.md` with front matter
   (`version`, `date`, `title`). Loaded at build time, rendered only through `renderMarkdown` (the kit `Markdown`
   component). Page `/releases` in `(app)`, newest first, one anchor per version. Linked from the sidebar and the
   phone "More" sheet. A "New" dot shows while the newest version is newer than the last one the viewer opened
   (`localStorage`, try/catch, per-viewer convenience; no migration). Notes written for staff, in plain English.
   First entries: 0.2.0 (2026-10-26) and 0.1.0.
2. **Version consistency.** `package.json` version, `APP_VERSION` in `wrangler.jsonc` and the newest release file
   must agree: a Vitest test fails otherwise, and `npm run deploy` refuses to start.
3. **Reload on update.** `kit.version.pollInterval` = 60 s; `updated` from `$app/state`. When true, a non-blocking
   banner "A new version of Ruby is available." with **Reload** and "What's new". Reload asks for confirmation only
   when a form on the page has unsaved input (in-app dialog, not `window.confirm`). After an update, the next
   client-side navigation becomes a full page load. `/_app/version.json` is never cached by the browser or shared
   caches.
4. **Mobile.** The banner sits above the phone tab bar and respects `--sai-*`; tap targets at least 44 px; no
   horizontal scroll at 360, 402 and 440 px.

## Out of scope

Per-user "what's new" tracking on the server, e-mail digests, release notes editing in the app.

## Security notes

Notes are repository content rendered by the one Markdown renderer. No user input reaches the page. No new route
accepts a body. `/releases` sits in `(app)`, so it needs a signed-in user like every other page.

## Tests

Vitest: release parsing, ordering, version consistency, deploy refusal, dirty-form detection. Playwright: `/releases`
renders, banner appears when `/_app/version.json` changes, Reload works, dirty-form confirm shows, mobile layout.
