---
description: Commit the current work with a Conventional Commit, push to origin, and deploy to production with npm run deploy once the gates have passed.
---

Instruction (optional, e.g. "no deploy"): $ARGUMENTS

1. `git status --short` and `git diff --stat`. If the tree is clean, say so and stop. Confirm `npm run gates` ran in this session on this tree; if not, run it now and stop on failure.
2. Compose the commit message: `type(scope): summary` in lowercase imperative, ≤ 72 chars, scope = feature slug or area (`auth`, `access`, `projects`, `tasks`, `pages`, `search`, `comments`, `notifications`, `files`, `admin`, `ui`, `deploy`, `CLAUDE.md`). Body: what changed and what is not verified. End with the attribution trailer from the session's system reminder. Stage only the files that belong to the work (`git add <paths>`, never `git add -A` with unrelated changes).
3. Tracker-only updates use `docs(tasks): …`. Otherwise include the tracker edits in the same commit as the code.
4. Push: `git push origin main` (if no `origin` remote exists, say so and stop after the commit).
5. Deploy decision (owner decision 2026-10-26: one environment, deploy after gates):
   - If the gates are green on this exact commit and `$ARGUMENTS` does not say "no deploy": run `npm run deploy`. It records the D1 Time Travel bookmark (copy it into the report), applies pending remote migrations, builds and runs `wrangler deploy`, and stops at the first failure. If a pending migration drops or rewrites data, stop before deploying and ask the owner.
   - Do not write the bookmark, version ids or hostnames into the repository (it is public); they go in the report only.
   - If the deploy fails, do not retry blindly: read the error, report it, and follow `docs/RUNBOOK.md` › Rollback if a bad version went live.
   - Never seed or reset the remote DB, never run migration commands against production outside `npm run deploy`, never create or change Cloudflare resources.
6. Report: commit sha, push result, deploy status (or reason skipped), the D1 bookmark, and what remains unverified in production.
