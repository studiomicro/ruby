# RB-05 Employee directory, profiles, org chart and HR access — PRD

Risk tier: **Large** (new authorization model, field encryption, audit trail, personal data under the PDP Law; engineer + QA + red team all mandatory).

Depends on: RB-00 (`requireUser`/`requireAdmin`, throttle, UI kit, `/admin/users`). Independent of RB-01..RB-04. Context and shared decisions: `docs/features/rb-05-hrm-roadmap.md` (sections 4, 5, 7, 8). RB-06 and RB-07 build on this PRD.

## Goal

Give the company one place for employee records that separates people from login accounts, shows a safe directory and an org chart to everyone, lets a manager see their team, and keeps identity, tax, insurance and bank data visible only to the employee and HR, encrypted, masked, and audited.

## Owner decisions (proposed defaults; roadmap section 8 numbering in brackets)

1. [2] HR = users with `is_hr = 1`, granted by an admin; admin is not implicitly HR; admin and HR can read the audit log.
2. [3] `employees` is its own table, optionally linked to one `users` row by HR.
3. [4] Manager sees direct reports' tier 1 only; never tier 2.
4. [6] NIK, NPWP, BPJS Kesehatan, BPJS Ketenagakerjaan, bank account and home address are stored encrypted. If the owner says no, drop the matching fields and the `employee_private` columns (no other change).
5. [5] Owner answer 2026-10-26: salary IS stored, HR-only — build `employee_compensation` per roadmap section 6 (tier 3: encrypted `amount_minor` integer IDR, `effective_on`, append-only history, reveal and change audited, never in lists, exports or search).
6. [7] Employee may edit own: preferred name, work phone, personal phone, home address, emergency contacts. HR edits everything else.
7. [12] Terminated employees stay forever in MVP (soft only); retention 5 years is a note, not enforced.
8. Directory size cap: 1 000 live employees (the org chart loads them all). Beyond that, the org chart shows a notice and the list still works.
9. Employee number: optional, unique among live rows, HR-entered.

## Scope

### Shared-file edits (explicit)

- `src/lib/shared/enums.ts`: add `EMPLOYMENT_TYPES = ['permanent','contract','probation','intern','part_time']`, `EMPLOYEE_STATUSES = ['active','terminated']`, `MARITAL_STATUSES` is **not** added (not collected).
- `src/lib/server/db/schema.ts`: add `users.isHr` and the new tables (below).
- Session user type and loader (`src/lib/server/auth/session.ts`, `src/lib/server/guards.ts`): `SessionUser` gains `isHr: boolean`; new `requireHr(event)` (calls `requireUser`, 403 when `!isHr`).
- `src/routes/(app)/admin/users/+page.server.ts` / `+page.svelte`: per-user "HR access" toggle, action `?/setHr` (admin only).
- App shell nav: link "People" (`/people`); "HR" group (Audit log, Export) shown only to HR; Audit log link also to admin.
- `src/lib/server/env.ts`: typed secret `HR_DATA_KEY` (optional string).
- `CLAUDE.md`, `docs/RUNBOOK.md`: per roadmap section 9.
- Throttle table: scopes `hr-reveal` (30 / 10 min / user) and `hr-export` (5 / 10 min / user).

### Migration `0002_hr_core.sql` (generate with Drizzle, then hand-check the triggers)

```
ALTER TABLE users ADD COLUMN is_hr integer NOT NULL DEFAULT 0 CHECK (is_hr IN (0,1));

employees(
  id text PK, user_id text REFERENCES users(id),
  employee_no text, full_name text NOT NULL, preferred_name text,
  job_title text, department text, location text,
  work_email text, work_phone text,
  manager_id text REFERENCES employees(id),
  employment_type text NOT NULL, status text NOT NULL DEFAULT 'active',
  start_on text, probation_ends_on text, end_on text,
  created_by text NOT NULL REFERENCES users(id),
  created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer)
  CHECK employment_type IN (...), CHECK status IN ('active','terminated')
  UNIQUE INDEX employees_user_uq ON employees(user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL
  UNIQUE INDEX employees_no_uq ON employees(employee_no) WHERE employee_no IS NOT NULL AND deleted_at IS NULL
  INDEX employees_manager_idx ON employees(manager_id)
  INDEX employees_status_name_idx ON employees(status, full_name)

employee_private(
  employee_id text PK REFERENCES employees(id),
  birth_date text,
  home_address_enc text, personal_phone_enc text, personal_email_enc text,
  nik_enc text, nik_last4 text, npwp_enc text, npwp_last4 text,
  bpjs_kes_enc text, bpjs_kes_last4 text, bpjs_tk_enc text, bpjs_tk_last4 text,
  bank_name text, bank_account_enc text, bank_last4 text, bank_holder_enc text,
  key_version integer NOT NULL DEFAULT 1,
  updated_by text NOT NULL REFERENCES users(id), updated_at integer NOT NULL)

employee_emergency_contacts(
  id text PK, employee_id text NOT NULL REFERENCES employees(id),
  name_enc text NOT NULL, relationship text NOT NULL, phone_enc text NOT NULL,
  position integer NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer)
  INDEX ON (employee_id, position)

hr_audit_log(
  id text PK, at integer NOT NULL, actor_id text NOT NULL REFERENCES users(id),
  action text NOT NULL, employee_id text REFERENCES employees(id),
  fields text NOT NULL DEFAULT '[]',   -- JSON array of field names, max 20 names, never values
  detail text NOT NULL DEFAULT '')     -- max 200 chars, non-sensitive, e.g. "42 rows"
  INDEX (at DESC), INDEX (employee_id, at), INDEX (actor_id, at)
TRIGGER hr_audit_no_update BEFORE UPDATE ON hr_audit_log -> RAISE(ABORT,'append-only')
TRIGGER hr_audit_no_delete BEFORE DELETE ON hr_audit_log -> RAISE(ABORT,'append-only')
```

`action` is not a CHECK-constrained column on purpose (RB-06/07 add actions without a table rebuild); the allowed values are the const list `HR_AUDIT_ACTIONS` in `src/lib/shared/enums.ts`, enforced in code and tests: `employee_create`, `employee_update`, `employee_terminate`, `employee_delete`, `employee_restore`, `sensitive_view`, `sensitive_update`, `emergency_update`, `user_link`, `user_unlink`, `hr_grant`, `hr_revoke`, `export`, `list_terminated`. Migration applies to a non-empty database without data loss (existing `users` rows get `is_hr = 0`).

### Routes (all under `src/routes/(app)/`; every load and action starts with `requireUser`, or `requireHr`/`requireAdmin` where stated)

| Route | Who | Purpose |
|---|---|---|
| `people/+page.*` | any active user | Directory list |
| `people/org/+page.*` | any active user | Org chart |
| `people/new/+page.*` | HR | Create employee (action `default`) |
| `people/[id]/+page.*` | any active user (content by tier) | Profile; actions `reveal`, `updateSelf`, `saveEmergency` |
| `people/[id]/edit/+page.*` | HR | Edit work/employment fields (`updateWork`), sensitive fields (`updateSensitive`), link/unlink user (`linkUser`, `unlinkUser`), `terminate`, `reinstate`, `delete`, `restore` |
| `hr/audit/+page.*` | HR or admin | Audit log, read-only |
| `hr/export/+server.ts` | HR | `GET` CSV download (tier 0 and 1) |
| `admin/users` action `?/setHr` | admin | Grant or revoke HR flag |

`:id` must be a uuid else 404.

### Page structure

- **Directory** `/people`: search input `q` (0-50 chars, matches `full_name`, `preferred_name`, `job_title`, `department`, `location`, `work_email` by escaped `LIKE %q%`, escaping `% _ \`), filter `department` (select of distinct departments), sort by name (default) or department, 50 per page (`?page=N`, 1-10 000), "Showing a-b of total". Columns: name (preferred name in brackets), title, department, location, manager, work phone, work e-mail. HR sees a `status` filter (`active` default, `terminated`, `all`) and a Terminated chip; others get active employees only (a `status` param from non-HR is ignored). Button "Add employee" (HR), "Export" (HR). Mobile: cards at < 768 px.
- **Org chart** `/people/org`: tree of active employees by `manager_id`; roots are active employees with no manager or whose manager is not active/live. Server builds the tree from one query (cap 1 000 rows), renders nested `<details>` (open to depth 2), each node = name, title, report count; works without JS. Depth beyond 10 is cut with "…". Cycles cannot exist (write guard) but the renderer tracks visited ids and never loops.
- **Profile** `/people/[id]` sections shown per viewer (roadmap 4.2):
  1. Header: name, title, department, location, manager link, status chip (HR/self/manager see status), linked-account badge (HR only).
  2. Contact (tier 0): work e-mail, work phone.
  3. Employment (tier 1; self, direct manager, HR): employee number, type, start date, tenure, probation end, end date.
  4. Personal and sensitive (tier 2; self and HR): birth date, home address, personal phone/e-mail, NIK, NPWP, BPJS numbers, bank name / account / holder. Each identifier shown masked (`•••• 1234`; addresses and e-mails shown as "Hidden" with Reveal) and a Reveal button (a form posting `?/reveal` with `field`; JS fetch replaces the text and hides it again after 30 s; no-JS renders a result page with the value once, `no-store`).
  5. Emergency contacts (tier 2): up to 3, name, relationship, phone masked with reveal.
  6. Self-edit form (own profile): preferred name, work phone, personal phone, home address, emergency contacts.
  Viewers without a section's rights do not get its data in the page payload at all (not hidden by CSS).
- **Create/Edit** (HR): three independent forms with independent `expectedUpdatedAt`: Work and employment (`employees`), Sensitive (`employee_private`), Emergency contacts. Terminate form: requires `end_on` (date) and a confirm checkbox. Delete: confirm checkbox; soft delete.
- **Audit log** `/hr/audit`: filters `actor` (select), `employee` (select with search), `action`, `from`/`to` date (in `TEAM_TIME_ZONE`), 50 per page, newest first, cursor `?before=<at>_<id>`. Columns: time, actor, action, employee, fields. No values exist to show.

### Server modules (`src/lib/server/hr/`)

- `crypto.ts`: `loadKey(env)` (null when missing or not 32 bytes after base64 decode), `encryptField(key, employeeId, field, plaintext)` → `v1.<iv>.<ct>`, `decryptField(...)`. Random 12-byte IV per call; AAD `employeeId|field`; tampering or wrong AAD throws; the error label never includes plaintext.
- `visibility.ts`: pure `viewerRelation(actor, employee)` → `'self' | 'manager' | 'hr' | 'other'`; `canSeeTier(relation, tier)`; `maskLast4(value)`.
- `validation.ts`: zod schemas and `HR_LIMITS`.
- `repo.ts`: `listEmployees`, `getEmployee`, `createEmployee`, `updateWork`, `updateSensitive`, `saveEmergencyContacts`, `linkUser`, `unlinkUser`, `terminate`, `reinstate`, `softDelete`, `restore`, `orgTree`.
- `audit.ts`: `auditStatement(db, {actorId, action, employeeId, fields, detail, now})` returns a batch item; `listAudit`.
- `export.ts`: `buildDirectoryCsv(rows)` with formula-injection neutralisation.
- `departments.ts`: `distinctDepartments(db)`.

### Validation (`HR_LIMITS`; all strings trimmed, NUL and C0/C1 controls stripped except `\n` in the address, zero-width and bidi characters stripped)

- `full_name` 1-100 single line; `preferred_name` 0-60; `job_title` 0-100; `department` 0-80; `location` 0-80 (free text, no department table).
- `work_email` 0 or valid address up to 254 chars, lowercased; `work_phone`, `personal_phone` 0 or `^[+0-9 ()-]{5,20}$`.
- `employee_no` 0 or `^[A-Za-z0-9._-]{1,20}$`. Duplicate among live rows: field error "That employee number is already used".
- `employment_type` in the enum. `start_on`, `probation_ends_on`, `end_on`: 0 or `YYYY-MM-DD` that round-trips through `Date.UTC`, between 1970-01-01 and 2100-12-31; `end_on >= start_on`; `probation_ends_on >= start_on`.
- `manager_id`: 0 or a live, non-terminated employee; not self; **must not be a descendant of this employee** (cycle guard, below).
- `user_id`: 0 or an active user not linked to another live employee.
- `birth_date`: 0 or date between 1900-01-01 and today minus 14 years.
- `home_address` 0-500; `personal_email` 0 or valid address; NIK 0 or exactly 16 digits; NPWP 0 or 15 or 16 digits (spaces, dots and dashes stripped before the check); BPJS Kesehatan and BPJS Ketenagakerjaan 0 or 8-20 digits; `bank_name` 0-60; `bank_account` 0 or 5-30 digits; `bank_holder` 0-100. Only length and digit checks; no checksum (formats change).
- Emergency contact: at most 3 live per employee; `name` 1-100, `relationship` 1-40, `phone` per phone rule, required.
- `expectedUpdatedAt`: integer >= 0, required on every update/terminate/delete/restore.
- Audit `fields`: names from the const field list only; max 20.
- Directory `q` up to 50 chars (longer → 400). Unknown filter values dropped.

### Authorization per action

| Action | Rule |
|---|---|
| Directory, org chart, profile tier 0 | `requireUser`; active employees only (terminated → 404 unless HR) |
| Profile tier 1 | self, manager of the employee (`employees.user_id` of the employee's manager equals actor), or HR |
| Profile tier 2 and `reveal` | self or HR. Manager, admin and others: 404 on the reveal action and no tier 2 in payload |
| `updateSelf`, `saveEmergency` | self only (HR editing someone else uses the edit page) |
| Create, `updateWork`, `updateSensitive`, link/unlink, terminate/reinstate, delete/restore | HR |
| `/hr/audit` | HR or admin |
| `/hr/export` | HR |
| `?/setHr` | `requireAdmin`; target must be an active user; an admin may change their own flag (owner answer 2026-10-26), audited like any grant |

Every action re-reads the employee server-side; ids from forms are never trusted for scope; hidden and missing give the same 404.

### Reveal flow

`reveal(field)`: `requireUser` → throttle `hr-reveal` → resolve relation (must be `self` or `hr`) → field must be in the sensitive allowlist and non-empty → key loaded (else 503 "Sensitive data storage is not configured") → if relation is `hr` (viewer is not the employee): `INSERT hr_audit_log` (action `sensitive_view`, fields `[field]`); an insert failure aborts with 503 and **nothing is decrypted** → decrypt → return `{value}` with `Cache-Control: no-store`. The value appears only in the action response, never in a load result, URL, log or error text.

### Concurrency

- Every update: `UPDATE ... SET ..., updated_at = max(:now, :expected+1) WHERE id=:id AND deleted_at IS NULL AND updated_at=:expected`, plus the audit insert in the same `db.batch` guarded by `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM employees WHERE id=:id AND updated_at=:newUpdatedAt)` so an audit row exists iff the write happened. 0 changes → re-read: deleted → 404, otherwise 409 with side-by-side values (same pattern as RB-01 task conflicts); sensitive fields are not echoed in the 409 page (masked).
- `employee_private` has its own `updated_at`; first write is an `INSERT … ON CONFLICT(employee_id) DO NOTHING` followed by the guarded UPDATE in the same batch.
- **Manager cycle guard** in SQL: the manager-change UPDATE adds `AND NOT EXISTS (WITH RECURSIVE sub(id) AS (SELECT :id UNION SELECT e.id FROM employees e JOIN sub ON e.manager_id = sub.id WHERE e.deleted_at IS NULL) SELECT 1 FROM sub WHERE id = :newManagerId)`. Two simultaneous edits that would together form a cycle: the second guard sees the first write and fails with a field error.
- **Link user**: unique partial index `employees_user_uq` is the arbiter; violation → "That account is already linked".
- **Employee number**: unique partial index; violation → field error.
- **Terminate**: guarded UPDATE (`status='active'`) sets `status='terminated'`, `end_on`; idempotent repeat answers success; RB-06 later adds "cancel pending leave" to the same batch. **Reinstate** clears `end_on`.
- **Delete/restore**: guarded on `deleted_at`; delete frees `employee_no` and `user_id` uniqueness (partial index excludes deleted); restore fails with a field error if either value was taken meanwhile.
- **Grant HR** (`setHr`): `UPDATE users SET is_hr=:v WHERE id=:id AND status='active' AND is_hr<>:v` plus audit insert in the same batch guarded by `changes`; repeat is idempotent.
- Emergency contacts: replace-set action; all rows are soft-deleted and re-inserted in one batch guarded by the `employee_private`/`employees` `updated_at`; max-3 check inside the batch via `INSERT … SELECT … WHERE (SELECT count(*) …) < 3`.

### States

Directory: skeleton rows while navigating; empty "No employees yet" (HR sees "Add the first employee"); filters match nothing "No employees match" + Clear. Profile: tier 2 section shows "Sensitive data storage is not configured" when the key is missing; reveal shows spinner, then value with "Hide"; errors inline; 429 "Too many reveals, wait a few minutes". Save shows success only after the server confirms. Audit: empty "No activity recorded". 409 conflict screen as in RB-01. Terminated chip; warning on a terminated employee whose linked account is still active ("This account is still active. Ask an admin to deactivate it.").

## Acceptance criteria

1. Signed-out requests to every route/action in this PRD are refused per RB-00; a deactivated user is denied.
2. A plain member can open `/people`, `/people/org` and any active employee's profile and sees tier 0 only. The page payload (HTML, `__data.json`, action results) contains no tier 1 or tier 2 value for them.
3. A direct manager sees tier 1 of their direct reports and no tier 2; a manager of a manager's report (skip-level) sees tier 0 only.
4. An employee linked to a user sees their own tier 1 and masked tier 2; `reveal` for own field returns the value and writes no audit row; changing own preferred name, work phone, personal phone, address and emergency contacts works and writes an audit row (`sensitive_update` or `emergency_update`) with field names only.
5. An employee cannot change their NIK, NPWP, BPJS, bank, birth date, employment fields, manager or user link even if the fields are posted (ignored with no error leak; audited as nothing).
6. HR sees all employees, including terminated, and can create/edit/terminate/delete/restore. `list_terminated` audit row is written when HR opens the terminated filter.
7. An admin who is not HR gets 403/404 on create/edit/reveal/export, can open `/hr/audit` (names of terminated or deleted employees hidden), and can toggle any active user's HR flag. Owner answer 2026-10-26: an admin may grant or revoke their own flag (the owner is the only admin and the only HR user); every grant and revoke is audited. Disabling an account clears its HR flag (audited); re-enabling does not restore it.
8. `reveal` by HR for someone else's NIK writes exactly one `sensitive_view` audit row naming the field, before returning the value; if the audit insert is forced to fail, the response is 503 and the value is not returned (integration, injected failure).
9. Reveal by a manager, an admin or another member returns 404 and writes no audit row; `field` outside the allowlist returns 400.
10. Without `HR_DATA_KEY` (or with a malformed one) the tier 2 form is read-only, saves of tier 2 are refused with 503, reveal is refused, no plaintext is stored anywhere, and tier 0/1 features still work.
11. Database inspection after saving an NIK shows only `v1.` ciphertext and `nik_last4`; the plaintext appears in no column, log line, audit row, error message or 409 page. Moving a ciphertext to another employee or another field makes decryption fail (AAD).
12. Validation: NIK 15 and 17 digits rejected, 16 accepted; NPWP 14 rejected, 15 and 16 accepted; bank account 4 digits rejected, 5 accepted, 31 rejected; dates like `2026-02-30` rejected; `end_on` before `start_on` rejected; 4th emergency contact rejected; 0 and 101-char names rejected; boundary lengths accepted.
13. A manager cannot be the employee, a descendant of the employee, or a terminated/deleted employee; two concurrent edits that would create a cycle: one fails (integration).
14. The same user cannot be linked to two live employees (concurrent test); employee number uniqueness per live row; deleting frees both, restoring after reuse fails cleanly.
15. Updating with a stale `expectedUpdatedAt` returns 409 and changes nothing; every successful update has exactly one audit row, and a forced audit failure rolls the update back (batch atomicity).
16. Terminate sets `status`, `end_on`; repeating is idempotent; reinstate clears them; terminated employees are absent from the directory and org chart for non-HR and return 404 on their profile.
17. Org chart shows the correct tree for a seeded 3-level hierarchy, handles an employee whose manager is terminated (shown as a root), and never loops.
18. Directory search: `%`, `_` and backslash in `q` match literally; `q` of 51 chars → 400; pagination 50 per page with correct total.
19. `/hr/audit` rows cannot be updated or deleted (trigger aborts raw `UPDATE`/`DELETE`); list is filterable and paginated without duplicates for equal `at`.
20. Export: HR only; contains tier 0 and tier 1 columns only; a name starting with `=`, `+`, `-`, `@` is prefixed with `'`; writes an `export` audit row with the row count; 6th export in 10 minutes → 429.
21. Throttle `hr-reveal` returns 429 after 30 reveals in 10 minutes and writes no audit row for the refused one.
22. Setting the HR flag: only admin, only active target; grant and revoke each write an audit row; revoking removes access immediately on the next request (flag read from D1 each request, not from the session cookie).
23. Text rendering: all employee text is rendered as plain text, never `{@html}`, no Markdown.
24. Logs: no employee name, e-mail, NIK or other tier 1/2 value in any `console` output (grep test on the module).
25. Every form works with JS disabled; every control has a label; tables degrade to cards at 360 px; no horizontal scroll.
26. Loading, empty, error, saving and success states exist as listed; success only after server confirmation.
27. `npm run check`, lint and tests pass; migration `0002_hr_core.sql` applies on a database with existing users without data loss.

## Test plan

Unit: crypto round trip, wrong AAD, wrong key, truncated token, missing key; `viewerRelation` matrix; `maskLast4`; every validator at its boundaries; CSV neutraliser; date helpers; `canSeeTier` table.
Integration (`openLocalD1`, `fakeEvent`, helper `test/helpers/seed-hr.ts` building admin, HR user, manager, report, skip-level, outsider, deactivated user, unlinked contractor): visibility matrix for every tier and viewer; reveal with audit, with injected audit failure, with missing key; update conflict and atomic audit; cycle guard race; link race; employee-number race; terminate/reinstate idempotence; soft delete/restore unique reuse; audit append-only triggers; export; throttle; admin HR toggle including self-toggle refusal; payload scans for tier 2 leakage in loader return values.
Red team: IDOR over `:id`, forged `field`, mass assignment of `userId`/`isHr`/`managerId` on `updateSelf`, tier 2 in `__data.json`, reveal replay, CSRF on reveal/setHr (RB-00 CSRF applies), CSV injection, audit tampering, timing differences between hidden and missing.
Manual: phone-width profile, reveal UX, no-JS reveal page, org chart with 200 seeded employees.

## Out of scope

Payroll; documents and ID-scan upload (Phase 2); employee change requests with HR approval (Phase 2); profile photos; dependants/marital status/PTKP; performance; skip-level visibility; bulk import; scheduled reports; anonymise-after-retention; field-level history of old values; e-mail or in-app notifications; key rotation tooling (`key_version` column reserved, value 1); department table; multiple managers; custom fields.

## Architecture notes

Reuse `newId`, `isUniqueViolation`, `errorLabel` (`src/lib/server/util.ts`), `todayIn` from `src/lib/server/tasks/dates.ts`, the throttle module, `return-to.ts`. New trees: `src/lib/server/hr/**`, `src/routes/(app)/people/**`, `src/routes/(app)/hr/**`, `test/helpers/seed-hr.ts`. Employee data must never enter FTS, notifications or comments. RB-03 `describeNotifications` and mentions keep using `users`, not `employees`.

## Prerequisites

Secret `HR_DATA_KEY` (base64 of 32 random bytes) set with `wrangler secret put HR_DATA_KEY`; `TEAM_TIME_ZONE` already set. When `HR_DATA_KEY` is missing the module runs with tier 2 disabled as described in criterion 10. Owner answers on roadmap section 8 decisions 2-7, 12, 14.

## Schema additions

Migration `0002_hr_core.sql` as listed above, plus `schema.ts`/`enums.ts` changes (new enum consts `EMPLOYMENT_TYPES`, `EMPLOYEE_STATUSES`, `HR_AUDIT_ACTIONS`, `SENSITIVE_FIELDS`).

## Tracker impact

New `docs/TASKS.md` items: "RB-05 Employee directory and HR access" (Claude) and "Set `HR_DATA_KEY` and choose HR users" (You). Adds rows to `docs/ACCEPTANCE.md`: HR access matrix (Automated), tier 2 encryption (Automated), audit-before-reveal (Automated), org chart (Pass).
