---
description: Verification-only pass for one acceptance item or journey: run the real checks, record evidence, update ACCEPTANCE/HISTORY/TASKS. No source changes.
---

What to verify: $ARGUMENTS

Rules: do not edit `src/`, `test/`, `scripts/` or `migrations/`. If verification needs a fix, stop and report; the owner decides whether to run `/fix-bug`.

1. Find the matching row(s) in `docs/ACCEPTANCE.md` and the CLAUDE.md requirement behind them. Pick the strongest available evidence level: **Pass** (real Cloudflare runtime, for example the deployed Worker or `wrangler dev` with local bindings and a real Access JWT) > **Automated** (Vitest on local D1) > **Mocked**. Never label a mocked or fixture-driven result as Pass.
2. Run it. Runtime checks run against local Cloudflare bindings (`wrangler dev` / `npx vite preview` after `npm run build`), never only the Node dev server. Fresh-DB checks use `npm run db:reset:local` (local only). Checks that need Cloudflare Access run only where the Access variables are set; otherwise the result is **Not run** with the exact variable name added as a `**You**` item.
3. Record: command, exit code, decisive output line, date, real or mocked, as a bullet in `docs/HISTORY.md` → `## Test evidence log`. Update the row in `docs/ACCEPTANCE.md`. Tick the To do item in `docs/TASKS.md` or leave it with a one-line reason.
4. Report only what ran and what it showed. Never report an unrun command as passed.
