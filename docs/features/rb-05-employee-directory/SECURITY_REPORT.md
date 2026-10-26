# RB-05 Employee directory, profiles, org chart and HR access — Security report (red team, cycle 1)

Scope: `git diff main..HEAD` at `b21c032` (wip cycle 1). This covers `src/lib/server/hr/` (crypto, access, visibility,
validation, repo, audit, reveal, grant, org, export), `/people/**`, `/hr/audit`, `/hr/export`, `?/setHr` in
`/admin/users`, migration `0002_hr_core.sql`, and the rebase-merged `src/lib/server/auth/throttle.ts`. I also read the
RB-00 pieces that RB-05 depends on: `hooks.server.ts` (cache headers), `csrf.ts`, `guards.ts`, `auth/session.ts`
(cookie flags) and `auth/users.ts`. The checks follow PRD, roadmap §4, §6 and §8.1, and
`docs/ENGINEERING_CHECKLIST.md`.

Proof tests use a key generated for each run:

- `test/security/rb05-d1.test.ts`: 16 tests against local D1.
- `test/security/rb05-pure.test.ts`: 7 tests (crypto, CSV, org tree, throttle).

Tests named `PROOF` document an open finding. They pass while the finding is open.

## Verdict: PASS

There are no medium or high findings. Three low findings and some informational notes are listed below. They are
tracked here and do not block.

## Findings

### L1 — low — A non-HR admin can see the names of terminated and soft-deleted employees on `/hr/audit`

- **Where:**
  - `src/routes/(app)/hr/audit/+page.server.ts:49` calls `listEmployeeNames`.
  - `src/lib/server/hr/repo.ts:200-208`: that query has no `deleted_at` or `status` filter.
  - `src/lib/server/hr/audit.ts:139`: the `employeeName` join.
- **Scenario:** an admin who is not HR is "as any active user" for the directory (roadmap §4.2). For a terminated or
  deleted employee, that admin gets a 404 on the profile, and the directory does not list the employee. On
  `/hr/audit` the same admin gets:
  - the employee filter, with every employee in any state;
  - rows such as `employee_terminate` and `employee_delete` that name the person.

  So "Terminated" and "Deleted" are tier 1 (status) and HR-only facts, and they reach a non-HR viewer. No tier 2 or
  tier 3 value leaks: the log holds field names only. Decision 14 gives admins read access to the log, which limits
  the impact.
- **Repro:** `rb05-d1.test.ts` › "PROOF L1 (open): a non-HR admin reads names of terminated and soft-deleted
  employees on /hr/audit".
- **Fix:** choose one of these.
  - (a) For a viewer without `isHr`, limit `listEmployeeNames` to `deleted_at IS NULL AND status = 'active'`. Show
    `employeeName` only when the employee is live and active, and otherwise show "a former employee".
  - (b) Record in the PRD that the owner accepts this as part of decision 14 ("watch the watchers"), and flip the
    proof test to a documented-behaviour test.

### L2 — low — `INSERT OR REPLACE` overwrites append-only rows; the triggers do not stop it

- **Where:** `migrations/0002_hr_core.sql:113-128`. Only BEFORE UPDATE and BEFORE DELETE triggers exist. SQLite's
  REPLACE conflict resolution deletes the old row without firing delete triggers, because `recursive_triggers` is off.
- **Scenario:** someone with raw D1 write access runs a REPLACE with an existing `id`. This can be the D1 console, a
  `wrangler d1 execute` command, or a future code path that uses `.onConflictDoUpdate`/`INSERT OR REPLACE`. The
  statement silently rewrites:
  - an `hr_audit_log` row (action, actor, fields);
  - an `employee_compensation` row (a salary history entry).

  The app has no such path today: every insert uses a fresh `newId()`, and `ON CONFLICT DO UPDATE` does abort (tested).
  An operator with console access could also drop the triggers, so this is defence in depth. It still means the
  "append-only" claim in `audit.ts:8` and in the RUNBOOK holds against UPDATE and DELETE only, not against REPLACE.
- **Repro:** `rb05-d1.test.ts` › "PROOF L2 (open): INSERT OR REPLACE rewrites an audit row and a salary row past the
  triggers".
- **Fix:** add migration `0003` with a BEFORE INSERT trigger on both tables:
  `CREATE TRIGGER hr_audit_log_no_replace BEFORE INSERT ON hr_audit_log WHEN EXISTS (SELECT 1 FROM hr_audit_log WHERE
  id = NEW.id) BEGIN SELECT RAISE(ABORT, 'hr_audit_log is append-only'); END;`. Add the same trigger for
  `employee_compensation`. Do not edit 0002.

### L3 — low — Soft delete, then a manager change, then restore can close a manager cycle

- **Where:**
  - `src/lib/server/hr/repo.ts:234-235`: `IS_DESCENDANT` walks only rows with `c.deleted_at IS NULL`.
  - `src/lib/server/hr/repo.ts:480-508`: `restore` runs no cycle check.
- **Scenario:** HR builds the chain C → B → A (C reports to B, B reports to A).
  1. HR soft-deletes B. The descendant walk from A now stops at B, so C no longer counts as being below A.
  2. HR sets A's manager to C. The guard allows it.
  3. HR restores B.

  The chain is now A → C → B → A, which the PRD's cycle guard says must never form.

  Impact today is small:
  - `buildOrgTree` (`org.ts:52-56`) uses a visited set, so the org chart still renders every node once (tested).
  - Tier 1 manager rights are direct-only, so the cycle widens no access.
  - It is still a broken invariant. RB-06 approval routing ("direct manager, then HR") and any later walk up the chain
    must not assume a tree.
- **Repro:** `rb05-d1.test.ts` › "PROOF L3 (open): soft delete, re-parent, restore closes a manager cycle; the org
  chart still terminates".
- **Fix:** choose one of these.
  - (a) Let the descendant walk in `IS_DESCENDANT` include deleted rows, so the walk sees the stored graph. Deleted
    employees keep `manager_id`.
  - (b) Put the guard inside the restore UPDATE: `AND (manager_id IS NULL OR NOT <IS_DESCENDANT(id, manager_id)>)`,
    walking from the restored row. On refusal, return the field error "Its manager now reports to this employee".

    Option (a) alone does not cover a restore whose stored manager was re-parented under it while it was deleted, so
    (b) is the complete fix. Add both to `test/integration/hr.test.ts` at the cycle test (`:505`).

### Informational (no action needed for PASS)

- **I1 — PRD AC7 versus code.** The PRD says "toggling one's own flag is refused". `grant.ts` allows an admin to grant
  themselves, which matches roadmap decision 2's fallback and the owner answer in §8.1. Change AC7 to match.
- **I2 — Disabling an account keeps `is_hr = 1`.** `auth/users.ts:155` sets only `status`. A disabled HR user has no
  HR rights: `loadViewer` requires `status = 'active'` (tested). If the account is re-enabled, HR access comes back
  without a new `hr_grant` row. Consider clearing `is_hr` on disable, with an `hr_revoke` audit row in the same batch.
- **I3 — `key_version` is written but not read on decrypt.** This is safe while only one key exists. Key rotation must
  add a version-to-key lookup before any second key exists. Without it, every value fails with "cannot be read with
  the current key" (fail closed, tested).
- **I4 — Short identifiers.** `last4` of a 5-digit bank account shows 4 of its 5 digits, and of an 8-digit BPJS
  number half of it. Only self and HR see the mask, so no unentitled viewer gains anything.
- **I5 — HR can add salary records to their own employee record.** This is by design, because the owner is the only
  HR user. Revisit it when a second HR user exists (segregation of duties).
- **I6 — `bank_name` and the contact `relationship` are plaintext tier 2 in the load for self and HR.** This follows
  the PRD schema, and no unentitled viewer receives them (tested).

## What held (with evidence)

- **Tier visibility for every role**, from the payload scans in `rb05-d1.test.ts`:
  - The roles tested were outsider, direct manager, skip-level, non-HR admin, self, HR, a disabled HR session and HR
    revoked mid-session.
  - The routes tested were the directory with search over `q` and `status=all`, the org chart, the profile, the edit
    page and the CSV.
  - No tier 2 or tier 3 plaintext, no `last4` below tier 2, no `v1.` ciphertext, and no tier 1 value except for the
    direct manager and self.
  - Directory `status` and `deletedAt` are forced to active/null for non-HR (`people/+page.server.ts:40`). Search
    and department options cover tier 0 columns of live, active rows only.
- **`__data.json`** returns the same load objects that were scanned.
- **Cache headers.** Signed-in responses get `private, no-store` (`hooks.server.ts:76`). The reveal sets `no-store`,
  and the export sets `no-store` and `nosniff`.
- **Crypto:**
  - A fresh 12-byte IV from `getRandomValues` (2000 encryptions, no repeat).
  - AAD `<row id>|<field>`. Swapping between fields, rows, contact fields and salary records always fails with a
    generic 500 and no value.
  - Tampered tag, IV, prefix or segment count fails closed.
  - The key is exactly 32 bytes, or the app is "not configured" (503 on reveal and on every tier 2/3 write, and no
    row changes).
  - The `CryptoKey` is not extractable, and no log line carries key material or values.
- **Reveal:**
  - Throttled (30 per 10 minutes) and audited before decryption, and refused if the audit insert fails (existing
    integration tests).
  - Refused attempts by others write no audit row.
  - The field allowlist runs before any SQL. Column-name injection such as `nik_enc`, `__proto__` and `bank_name` gets
    400.
  - Contact and salary `ref` values are bound to the employee in the URL.
  - Self cannot reveal salary.
  - A repeated `field` reveals only one value.
  - CSRF: `csrf.ts` refuses cross-site and Origin-less form posts, Content-Type-less ones included. The cookie is
    `SameSite=Lax`.
- **Grants:**
  - `setHr` uses `requireAdmin`. Inside the UPDATE, a stale or demoted admin session is refused, and so is a disabled
    target.
  - No-op grants write no audit row. Unknown values get 400. The audit row is guarded by `changes() = 1`.
  - Last HR: revoking the only HR user is allowed and recoverable, because an admin can grant again.
- **IDOR.** `removeContact` with another employee's contact id gets 404 and the contact stays live. Self and manager
  writes go through `writable()`. Edit actions use `requireHr` before any id lookup.
- **Soft delete.** Deleted employees vanish for non-HR viewers. A deleted linked record ends self and manager rights.
  Employee-number reuse and restore conflicts are covered by the existing integration tests.
- **CSV.** `=`, `+`, `-`, `@`, tab and CR are prefixed in every exported column. Every cell is quoted, and quotes are
  doubled. Only tier 0 and tier 1 are exported.
- **Org chart DoS.** A 1000-node cycle plus a self-loop builds in milliseconds, with every node once and depth capped
  at 10. The query is capped at 1001 rows.
- **XSS.** There is no `{@html}` in the HR UI or routes. `mailto:` and `tel:` hrefs carry validated values with a
  fixed scheme.
- **Rebase merge of `throttle.ts`.** The diff against `main` only adds `hr-reveal` and `hr-export` and a comment.
  These are unchanged:
  - `THROTTLE_WINDOW_MS` is 10 minutes;
  - `THROTTLE_MAX_ATTEMPTS` is 20;
  - `CLIENT_MAX_ATTEMPTS` is 100;
  - the minute window is unchanged;
  - every RB-00 to RB-03 call site is unchanged.

  `rb05-pure.test.ts` pins these values.

## Commands

- `npm ci --prefer-offline --no-audit --no-fund` exited 0, then `npx svelte-kit sync` exited 0.
- `npx vitest run test/security/rb05-d1.test.ts`: 16 passed.
- `npx vitest run test/security/rb05-pure.test.ts`: 7 passed.
- `npm test`: exit 1, with 883 passed and 1 failed out of 884. The failure is
  `test/security/rb01-board.test.ts` › "400 alternating midpoint drops…": `Test timed out in 30000ms`. It also times
  out when run alone. RB-05 does not touch that code, since its only `tasks/` change is a refactor in `dates.ts`, so
  this looks like a slow-machine timeout in an RB-01 stress test. It needs triage separately.
  `npm test` was run a second time only to read the name of the failing test, with the same result.
