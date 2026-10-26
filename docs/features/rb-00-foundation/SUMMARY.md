# RB-00 Foundation — summary

**Status: complete** (2026-10-26).

Goal: the base every Ruby feature builds on — two access layers (Cloudflare Access JWT verified by the app, plus
invite-only e-mail/password accounts), the app shell with phone layout, the UI kit, safe Markdown and the deploy path.

- Built by the senior engineer; red team FAIL (M1 + 9 Low) → fix cycle 1 → re-check PASS; re-check N1 (stale JWKS
  flight) and N2 (flaky timing test) fixed by the orchestrator with a regression test.
- Accepted, not fixed: L4 (small sign-in timing difference), L7 (Access identity not compared with the account).
- Follow-up for RB-03: loaders that render comments must pass `mentionNames(db, ids)` to the Markdown component.
- Migrations: `0000_init.sql`, `0001_search.sql`.
