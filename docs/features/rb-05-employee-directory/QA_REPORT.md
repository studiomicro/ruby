# RB-05 QA report

**Verdict: PASS** (no product defects found; one pre-existing/timing-sensitive e2e flake noted, severity Low).

Scope: RB-05 tip rebased on main, detached worktree `rb-05-qa`. Owner answers (roadmap 8.1) override PRD defaults: salary stored HR-only; NIK/NPWP/BPJS/bank encrypted, masked, audited reveal; owner is the only HR user. Accepted deviations (admin self-grant audited, every reveal audited incl. self, export POST, `is_hr` read from D1 per request, emergency contacts one at a time, sensitive inputs never prefilled) were treated as the spec.

## Commands run
- `npm ci --prefer-offline --no-audit --no-fund` then `npx svelte-kit sync`: exit 0 (real npm cache).
- `npm run gates`: exit 0 (check, lint, test, build all clean; real tooling, local D1 fixtures).
- `npx vitest run` (full, with QA probes added): 43 files, 865 tests passed, exit 0 (local D1 via miniflare, no real service).
- `npx vitest run test/qa/rb05-probes.test.ts`: 4 passed, exit 0.
- `RUBY_E2E_PORT=4421 npm run test:e2e` (fresh server, wrangler dev local D1, throwaway HR_DATA_KEY): 136 passed, 1 failed (`rb03-qa.spec.ts:36` desktop, 429 instead of 409; see F1). Without `e2e/rb05-qa.spec.ts`: 129 passed, 0 failed. `rb03-qa` alone: 5 passed. All RB-05 specs (people.spec.ts, rb05-qa.spec.ts) pass on iphone-402, iphone-440, phone-360 and desktop.
- `npx prettier --check test/qa e2e` / `npx eslint test/qa e2e`: clean.
- `npm run db:reset:local`: exit 0, all migrations (incl. 0002) apply on fresh local DB.

## Checked criteria (AC = PRD numbering)
- AC1 signed-out refused everywhere; deactivated denied: PASS. `hr.test.ts` "signed-out requests are refused everywhere"; new probe `test/qa/rb05-probes.test.ts` "session gate refuses every HR route ... disabled" (/people, /org, /new, /hr/audit, /hr/export: control 200 while active, not 200 and resolve never called after disable) and "stale user object": disabled HR user gets 403 on new/audit/export/edit and tier 0 only on profile (`loadViewer` requires `status='active'`).
- AC2 member sees tier 0, no tier 1/2 in payload: PASS (`hr.test.ts` "a member sees tier 0 only").
- AC3 manager tier 1 only, skip-level tier 0: PASS (same file).
- AC4 self: PASS with accepted deviation (own reveal is audited). Own edits work; field-name-only audit (`self-service` tests).
- AC5 employee cannot change restricted fields: PASS ("other posted fields are ignored").
- AC6 HR sees/edits all, `list_terminated`: PASS (HR writes + directory tests).
- AC7 admin not HR: 403 on HR pages, can read audit, can grant: PASS. Self-toggle refusal replaced by audited self-grant (accepted).
- AC8 audit row before value; injected failure gives 503, no value: PASS.
- AC9 non-self/non-HR reveal 404, no audit; bad field 400: PASS.
- AC10 no `HR_DATA_KEY` / malformed: PASS. Probe: unset, `''`, `AAAA`, `not base64 !!` all give `keyReady=false`; `updateSensitive` 503; reveal 503/400; `employee_private.nik_enc`/`nik_last4` stay NULL. UI text present on profile ("Sensitive data storage is not configured. These fields are read-only.") and edit page ("... Nothing sensitive can be saved."), inputs `disabled={!data.keyReady}`. Verified by source and load result, not by a keyless browser run.
- AC11 ciphertext only, AAD binding: PASS (crypto unit tests, "a ciphertext moved ... no longer decrypts", DB inspection test).
- AC12 validation boundaries: PASS (`hr.test.ts` validation block).
- AC13 manager rules and concurrent cycle: PASS. AC14 link/number races, restore after reuse: PASS (20 concurrent links).
- AC15 409 on stale, atomic audit rollback: PASS. AC16 terminate/reinstate: PASS.
- AC17 org chart 3-level, terminated manager = root, no loop: PASS; extra probe: 200 employees (5 levels, branching 4) all rendered, `capped=false`, load under 2 s, payload has no tier 1 fields.
- AC18 search literals, 51 chars 400, 50/page: PASS. AC19 audit append-only, cursor without duplicates: PASS.
- AC20 export: PASS (POST by accepted deviation; tier 0/1 only, neutralised, `export` audit row, 6th = 429).
- AC21 reveal throttle 30/10 min, no audit on refused: PASS. AC22 HR flag admin-only, audited, immediate revocation: PASS.
- AC23 plain text rendering: PASS (no `{@html}` in RB-05 svelte files; grep). AC24 logs: PASS (logging grep test).
- AC25 no-JS forms: PASS. New e2e `rb05-qa.spec.ts` with JS disabled (4 viewports): create employee, store NIK, profile HTML holds only last4, reveal POST responds `cache-control: no-store`, value shown on the result page, a fresh GET does not contain it, audit row listed.
- AC25 mobile: PASS at 402x874, 440x956, 360x780 and desktop: no horizontal scroll on /people, ?status=all, /people/org, /people/new, profile, edit, /hr/audit, /admin/users (new e2e); 44 px touch targets (people.spec).
- AC26 states: PASS (empty/error/saving/success banners seen in e2e and source).
- AC27 check/lint/tests pass; migration on non-empty DB: PASS (`0002 applies to a database with existing users without data loss`).
- Engineer-noted gaps: no-JS reveal page covered; 200-person org covered; HR pages as deactivated user covered.

## Findings
- F1 (Low, test infra, not product): `e2e/rb03-qa.spec.ts:171` can get 429 instead of 409 on the desktop project when the whole e2e suite runs in parallel (comment write throttle of the shared seeded admin, 20/min, is timing sensitive). Repro: `RUBY_E2E_PORT=4421 npm run test:e2e` several times; fails about 3 of 4 runs with `e2e/rb05-qa.spec.ts` present, 0 of 1 clean run without it; passes alone. Not caused by RB-05 product code; RB-03 spec is the one to harden (use a separate user for the throttle probe). A separate run also showed one `projects.spec.ts:76` iphone-402 `toHaveURL` failure, same class (parallel load), passed in the other runs.
- No defects in `src/` found. Checklist items touched by the diff (auth guard on every load/action, no logging of values, soft delete, UTC ms timestamps) hold.

## Untested
- Keyless browser render of the "not configured" banner (verified through load output and source only).
- Deployed-host Access JWT behaviour for the new routes (covered generically by RB-00 hooks tests).

## Proof tests added
- `test/qa/rb05-probes.test.ts`, `e2e/rb05-qa.spec.ts`
