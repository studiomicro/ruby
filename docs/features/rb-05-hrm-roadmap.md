# HRM roadmap (umbrella for RB-05, RB-06, RB-07; RB-08 is the separate project-management increment)

Status: **proposal, awaiting owner answers** to "Owner decisions" below. Author: CTO strategist, 2026-10-26.
Owner request (2026-10-26): "add an HRM feature on the app. add kanban and project management feature too".

## 1. What the reference page describes (behaviour only)

The owner pointed at a public HRMS product page. Only behaviour is mirrored here. No name, logo, copy, illustration or
product name from that page is used anywhere in Ruby, and a public marketing page is not source code. The page
describes these modules:

| Module on the page | Behaviour described |
|---|---|
| Payroll | Automatic salary calculation from attendance and performance; tax and allowance rules (PPh 21, BPJS); digital payslips; batched bank transfer file or API |
| Attendance | Smartphone check-in/out with GPS and selfie; shifts and flexible hours; live team dashboard; late and overtime feed payroll |
| Time off (leave) | Employee requests in app; fast approval; quota balances update automatically |
| Expenses / reimbursement | Employee submits reimbursement claims |
| Employee self-service | Employee views payslips, leave balance, attendance; requests changes to personal data (address, bank account); **HR verifies** the change before it takes effect |
| Documents | Employee downloads payslips, tax withholding certificates, employment letters |
| Employee database | Personal records kept current by employees and verified by HR |
| Recruitment (ATS) | Job postings, candidate pipeline, CV bank |
| Performance | KPI/OKR targets; competency matrix and career planning |
| Reports | On-demand and scheduled reports (BPJS recap, overtime, demographics) |
| HR dashboard / analytics | Headcount, attendance, turnover, demographics, cost; correlations |

Not on the page but standard and wanted by a small company: org chart and onboarding/offboarding checklists. They are
included below because the owner's list names them as examples.

## 2. Product stance for Ruby

Ruby is an internal tool for one company (in Indonesia). It is not an HR suite. Build the parts that remove daily
friction and that need no outside integration, keep the personal data minimal and well protected, and refuse
anything that creates legal or financial liability without a specialist (payroll tax, biometric attendance).

Hard constraints already locked in `CLAUDE.md` that shape this plan: one Worker, no queues or background jobs, no
e-mail sending, UTC millisecond timestamps, calendar dates as `YYYY-MM-DD` interpreted in `TEAM_TIME_ZONE`
(`Asia/Jakarta`), soft delete, `requireUser`/`requireAdmin` on every entry point, English UI, D1 `db.batch` with no
interactive transactions. The statement "every active user sees everything" does **not** hold for HR data. HR is a
documented exception (section 4). `CLAUDE.md` must be amended in the first HR PR (see section 9).

## 3. Phases and module map

### Phase 1 (MVP, PRDs written now)

| Id | Module | Maps to page module | Summary |
|---|---|---|---|
| RB-05 | Employee directory, profile, org chart, HR access model, audit log | Employee database; Documents (no) | Employee records separate from login accounts; three data tiers; encrypted sensitive fields with reveal-and-audit; manager tree; HR audit log; HR directory export |
| RB-06 | Time off | Time off / attendance (leave part only) | Leave types, half-day granularity, balance ledger, manager approval, holidays calendar, who-is-out calendar |
| RB-07 | Onboarding and offboarding checklists | not on the page | Reusable templates, per-employee runs with owner roles and due dates |
| RB-08 | Project management plus | n/a (separate request) | Labels, checklists, milestones, column names/hide/WIP limits, saved views, bulk edit on top of RB-01 |

Build order: RB-05 first (RB-06 and RB-07 depend on its employee table and HR guard). RB-08 is independent and can run
in parallel with RB-05.

### Phase 2 (PRD when Phase 1 is live)

- Employee documents vault: contracts, ID scans, certificates per employee, own R2 prefix `hr/` and own download
  route with the HR access rules. Do not reuse RB-04 `/files` (its ACL is "any active user").
- Employee self-service change requests: employee proposes a change to bank/NIK/address, HR approves (the page's
  "HR verifies" behaviour). MVP lets HR edit and the employee edit low-risk fields only (RB-05 decision 7).
- Employment letters from a Markdown template (surat keterangan kerja), generated on screen for print/PDF-by-browser.
- Notifications for leave and onboarding events: needs a table rebuild of `notifications` because its CHECK
  constraints only allow kinds `mention|assigned|comment` and targets `task|page`. Until then RB-06 and RB-07 use
  badges and queue pages.
- Reimbursement claims: amount as integer minor units plus ISO currency (`IDR`, which has no decimals in practice;
  still store `amount_minor` and `currency`), receipt attachment, manager then HR approval, status, export. No payment.
- Basic HR reports: headcount by department, leave usage per month, tenure. Live pages with CSV export, no scheduled
  e-mail.
- Performance, light: goals per employee per period with progress notes and a review cycle (self review, manager
  review, HR sees). KPI/OKR dashboards stay out.
- Compensation record (only if owner decision 5 flips to yes): see section 6.
- Anonymise-after-retention action for terminated employees (see section 7).

### Later / explicitly out of scope for the first version

- **Payroll calculation (PPh 21, BPJS contributions, THR, overtime, payslips, bank transfer file): OUT.** The tax
  schedules (TER method since 2024, PTKP, progressive brackets, year-end reconciliation) and BPJS caps change by
  regulation, errors cause real tax and labour disputes, and it needs finance sign-off. Ruby stores only the
  identifiers (NPWP, BPJS numbers) that an external payroll provider or accountant asks for, and can export them.
  Re-evaluate only with a finance owner and a regulation reviewer.
- **Attendance with GPS and selfie: OUT.** Location and face images are personal data; biometrics and precise
  location need an explicit legal basis and stronger safeguards under the PDP Law, and the image storage and
  anti-spoofing work is a product of its own. A later light option: self-reported daily status (office / WFH / out)
  with no location and no photo. Not in Phase 2 unless the owner asks.
- Recruitment / ATS and careers page: public surface, outside the "no public pages" boundary.
- Scheduled e-mailed reports: no e-mail path and no background jobs.
- Analytics that correlate performance, attendance and turnover: profiling employees is a legal and ethical risk and
  needs far more data than a small company has.
- Native mobile app, geofencing, shift scheduling, multi-company, multi-country, i18n.

## 4. Access-control model

### 4.1 Capabilities

Keep the two roles `admin` and `member` (`USER_ROLES` unchanged). Add one **capability flag** `users.is_hr`
(0/1, default 0). Reasons: HR duty is orthogonal to user administration; a role enum change needs a table rebuild
(CHECK constraints in SQLite); a flag keeps `requireAdmin` semantics intact.

- `is_hr = 1` users are "HR". Admins grant or revoke it at `/admin/users`; each grant and revoke writes an audit row.
- **Admin is not implicitly HR.** Admin can see HR data only after granting itself the flag, and that grant is audited
  and visible. Admin gets read-only access to the HR audit log (so the owner can watch the watchers).
- Employees are people, not accounts. An `employees` row may link to a Ruby `users` row (`employees.user_id`,
  unique among live rows). The link is set by HR by hand, never by e-mail match.

### 4.2 Who sees what

| Viewer | Tier 0 directory | Tier 1 employment | Tier 2 sensitive | Leave (RB-06) | Onboarding (RB-07) |
|---|---|---|---|---|---|
| Any active user | all employees with status active | no | no | who-is-out calendar only (no leave type, no reason) | items they own |
| The employee (own record) | yes | yes | yes, masked, reveal allowed | own requests and balances | own onboarding run |
| Direct manager | yes | direct reports | **no** | direct reports' requests and balances, approve/reject | direct reports' runs |
| HR | all including terminated | all | all, reveal audited | all, approve any, adjust balances | all |
| Admin (not HR) | as any active user | no | no | as any active user | as any active user |

"Manager" means the user linked to `employees.manager_id` of the employee, direct reports only. Transitive
(skip-level) visibility is not granted (owner decision 4).

### 4.3 Field tiers

- **Tier 0 (all active users):** full name, preferred name, job title, department, work location, work e-mail, work
  phone, manager.
- **Tier 1 (self, direct manager, HR):** employee number, employment type, status, start date, probation end date,
  end date.
- **Tier 2 (self and HR only):** birth date, home address, personal phone, personal e-mail, NIK (national ID number),
  NPWP (tax number), BPJS Kesehatan number, BPJS Ketenagakerjaan number, bank name, bank account number and holder
  name, emergency contacts. Health-related data (leave type "sick" and reasons) is treated the same way in RB-06.
- **Tier 3 (HR only, not even self-editable):** salary and any compensation. Not stored in the MVP (decision 5).

### 4.4 Controls on tier 2

1. **Encryption at rest per field.** AES-256-GCM in the Worker with key secret `HR_DATA_KEY` (32 random bytes,
   base64). Stored form `v1.<iv b64>.<ciphertext b64>`; associated data is `<employeeId>|<fieldName>` so a ciphertext
   cannot be moved to another row or field. Cloudflare encrypts D1 at rest anyway; this layer protects D1
   exports/Time Travel restores and anyone with database read access but no Worker secret. If `HR_DATA_KEY` is
   missing or malformed, tier 2 is **read-only and shows "Sensitive data storage is not configured"** (fail closed);
   nothing is stored in plaintext as a fallback.
2. **Masked by default.** Lists and the profile show `•••• 1234` (last 4 digits kept in a separate non-secret
   column). The full value is returned only by an explicit POST action `reveal` for one field, never in a loader
   payload, with `Cache-Control: no-store`. The client hides it again after 30 seconds.
3. **Audit.** Every reveal, every write to tier 2, every export, every HR grant/revoke and every HR-only listing of
   terminated staff writes an append-only `hr_audit_log` row (actor, action, employee, field names only, time).
   Values are never written to the audit log or to console logs. The reveal is refused if the audit insert fails
   (fail closed). Reveals of one's own record are not audited (noise); changes to one's own record are.
4. **Throttle** `hr-reveal`: 30 per 10 minutes per user; `hr-export`: 5 per 10 minutes per user.
5. **Exports** contain tier 0 and tier 1 only, are HR-only, audited, and neutralise CSV formula injection (cell starting
   with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`). Exporting tier 2 in bulk is not offered.
6. **Search never indexes tier 1 or 2.** Employees are not added to `pages_fts`/`tasks_fts`; directory search is a
   bounded `LIKE` on tier 0 columns.
7. Hidden and missing look the same (404) for terminated employees seen by non-HR and for other people's tier 2.

## 5. Data model sketch and migrations

Names are stable; migration numbers are the next free number at merge time (assuming merge in this order).

| Migration | Module | Contents |
|---|---|---|
| `0002_hr_core.sql` | RB-05 | `ALTER TABLE users ADD COLUMN is_hr integer NOT NULL DEFAULT 0` (CHECK 0/1); `employees`; `employee_private`; `employee_emergency_contacts`; `hr_audit_log` plus triggers that abort UPDATE and DELETE on it |
| `0003_time_off.sql` | RB-06 | `leave_types` (seeded with Annual, Sick, Unpaid, Special); `leave_requests`; `leave_ledger` (append-only triggers); `holidays`; `app_meta` row `work_days` |
| `0004_onboarding.sql` | RB-07 | `checklist_templates`, `checklist_template_items`, `checklist_runs`, `checklist_run_items` |
| `0005_pm_plus.sql` | RB-08 | `labels`, `task_labels`, `task_checklist_items`, `milestones`, `project_columns`, `saved_views`; `ALTER TABLE tasks ADD COLUMN milestone_id text REFERENCES milestones(id)` |

Relationship summary:

```
users 1 --- 0..1 employees (user_id, unique among live rows)
employees 1 --- 0..1 employee_private (encrypted tier 2)
employees 1 --- * employee_emergency_contacts
employees * --- 0..1 employees (manager_id; no cycles)
employees 1 --- * leave_requests, leave_ledger, checklist_runs
hr_audit_log (actor users.id, employee employees.id nullable)
```

Conventions kept: text ids from `newId()`, UTC ms `created_at`/`updated_at`, `deleted_at` on deletable rows, enums in
`src/lib/shared/enums.ts` with CHECK constraints via `oneOf`, optimistic concurrency on `updated_at`. Exceptions
stated in the PRDs: append-only tables (`hr_audit_log`, `leave_ledger`) have no `updated_at`/`deleted_at`.

D1 limit to remember in every module: at most 100 bound parameters per statement. Pass id lists as one JSON parameter
and use `IN (SELECT value FROM json_each(?))`.

## 6. If the owner wants salary stored (decision 5)

Separate table `employee_compensation` (HR only, tier 3): `employee_id`, `effective_on`, `amount_minor` integer,
`currency` = 'IDR', `note`, encrypted amount column like tier 2, append-only history, reveal-and-audit identical to
tier 2, never in lists, exports or search. Needs its own PRD. Default is **do not store**.

## 7. Indonesian compliance notes (verify with counsel; this is design guidance, not legal advice)

- **Personal data (UU 27/2022 PDP):** The company is the data controller for employee data. Needs a lawful basis (employment
  contract / legal obligation), data minimisation (collect only fields used), purpose limitation, access/correction
  rights for the employee (the employee can see their own record: built in), security measures (tier 2 encryption,
  audit), and a breach-notification process (the PDP Law sets a short notification window; keep a runbook entry).
  Financial data, health data and biometrics are "specific" personal data with extra duties, which is why bank
  account, sick-leave detail and selfie/GPS are handled as they are. Hosting is Cloudflare; set the D1 location
  hint to the Asia-Pacific region when creating the database if not already and record the cross-border-transfer
  position in the runbook.
- **Retention:** keep terminated employee records for a company-defined period (employment, tax and social
  insurance records usually must be kept for years; Law 8/1997 on company documents sets long periods for financial
  records). The MVP never hard-deletes; Phase 2 adds anonymise-after-period. Owner decision 12.
- **Annual leave:** Law 13/2003 art. 79 (retained in the omnibus-law amendments and PP 35/2021) gives at least 12
  working days per year after 12 months of continuous service; the employer may be more generous (default below
  prorates earlier). Statutory paid special leave (marriage 3 days, child's marriage / circumcision / baptism 2 days,
  wife's childbirth or miscarriage 2 days, death of spouse/parent/child/in-law 2 days, death of household member
  1 day), menstrual leave (art. 81, up to 2 days when the worker reports pain), maternity leave (1.5 months before
  and 1.5 months after birth) and sick-leave pay rules exist. Ruby models them as leave types HR can configure; it does
  not enforce the pay consequences.
- **Public holidays and cuti bersama:** set each year by the joint ministerial decree (SKB 3 Menteri). Dates, and
  whether cuti bersama deducts annual leave, vary by year and by company. Ruby ships **no hard-coded holiday list**;
  HR enters the year's list (RB-06) and a banner warns when the current year has none.
- **Work week:** 5-day or 6-day week is a company choice; the work-day set is configurable (default Mon-Fri).
- **BPJS and tax identifiers:** store the BPJS Kesehatan and BPJS Ketenagakerjaan numbers, NIK and NPWP (NPWP for
  individuals now generally equals the 16-digit NIK; legacy 15-digit numbers still exist) for the payroll provider.
  Format validation is digits-only with a length range, not a checksum, so a format change does not lock records.
  No contribution or PPh 21 calculation happens in Ruby.
- **Employment letters** and tax withholding certificates (bukti potong) come from payroll; out of scope until payroll is.

## 8. Owner decisions (answer once before RB-05 starts; each has a proposed default)

1. **Which modules first?** Default: RB-05 directory + org chart, then RB-06 time off, then RB-07 onboarding;
   RB-08 project-management increment in parallel.
2. **Who is HR?** Default: one or two named people the owner picks, granted `is_hr` by an admin. Admin is not
   automatically HR. Fallback if the owner is also the only HR: the owner grants themselves the flag (audited).
3. **Employees = Ruby users or a separate table?** Default: separate `employees` table with an optional link to
   `users`, because contractors, new hires before they have an account and ex-employees must exist without a login.
4. **Manager visibility depth.** Default: direct reports only, for tier 1 and for leave approval. Skip-level is
   not granted.
5. **Store salary / compensation at all?** Default: **no** in MVP (reduces blast radius). Say yes only if you want it
   in a later phase (section 6).
6. **Store NIK, NPWP, BPJS numbers and bank account?** Default: **yes, encrypted, masked, reveal audited, HR-only
   edit**, because the accountant/payroll provider needs them. If you will not use them in Ruby, say no and the
   fields are dropped from RB-05 (smaller risk).
7. **What may an employee edit about themselves?** Default: preferred name, work phone, personal phone, home address,
   emergency contacts (edits are audited). NIK, NPWP, BPJS, bank, birth date: HR only until the Phase 2 change-request
   flow.
8. **Leave year and entitlement.** Default: calendar year; Annual leave 12 days (24 half-days); in the first year it
   accrues 1 day per full month from the start date (start on the 1st counts that month), 12 from the next January.
   More generous than the statute's 12-month wait; say "statutory only" to change it to 12 months of service.
9. **Carry-over.** Default: none automatic; HR can add an audited positive adjustment (for example up to 5 days).
10. **Approval chain.** Default: one step, the direct manager, or HR when the requester has no manager, or another HR /
    admin when the requester is the approver. HR can approve or reject any request. No multi-level chains.
11. **Public holidays.** Default: HR enters each year's list from the government decree, including cuti bersama; whether a
    cuti bersama day deducts annual leave is a per-holiday flag (default: it does not deduct, it is a non-working day).
12. **Retention of terminated employees' data.** Default: keep for 5 years after the end date, soft only in MVP; owner
    and counsel confirm the period before the Phase 2 anonymise action.
13. **Offboarding visibility.** Default: the leaving employee does not see their offboarding checklist; onboarding is
    visible to the new hire.
14. **Admin access to the HR audit log.** Default: read-only for admins and HR.
15. **Notifications.** Default: no e-mail and no notification-table change in MVP; badges and queue pages instead.
    Approve the table rebuild in Phase 2 if you want inbox entries for leave and onboarding.
16. **Terminating an employee also deactivates the account?** Default: no automatic action; the offboarding checklist
    includes an item for an admin to deactivate the account, and the profile shows a warning while a terminated
    employee still has an active account.

### 8.1 Owner answers (2026-10-26)

- Decision 5 (salary): **store salary, HR-only** — the `employee_compensation` design of section 6 is built inside
  RB-05 (tier 3: encrypted, never in lists, exports or search, every reveal and change audited, append-only history).
- Decision 6 (NIK/NPWP/BPJS/bank): **yes, encrypted** (default).
- Decisions 8–10 (leave): **UU default** — calendar year, 12 days, prorated 1/month in year 1, no carry-over (HR
  adjusts), direct manager then HR approves.
- Decision 2 (HR): **the owner only for now** — the owner's admin account gets `is_hr`; others can be granted later.
- Decision 10 addendum (2026-10-26, RB-06 QA D2): **audited self-approval** — only while no other eligible approver
  exists (no manager, no other active HR user), the requester may approve their own request; it is marked
  self-approved and written to `hr_audit_log`; it switches off automatically once a manager, a second active HR user
  or another active admin exists (owner answer 2026-10-26: an admin counts as an eligible approver).
- Every other decision: the proposed default.

## 9. Required edits to project docs (done in the RB-05 PR)

- `CLAUDE.md` "Product boundaries": add "HR data is the one exception to 'every active user sees everything'; see
  `docs/features/rb-05-hrm-roadmap.md` section 4"; add secret `HR_DATA_KEY`; add routes `/people`, `/people/org`,
  `/hr/audit`, `/hr/export`, `/time-off`, `/onboarding`; extend the feature-id list with RB-05..RB-08; add the
  "never log employee personal data" rule next to the existing page/comment rule.
- `docs/RUNBOOK.md`: how to create and rotate `HR_DATA_KEY` (`wrangler secret put HR_DATA_KEY`), what to do when it is
  lost (tier 2 values are unrecoverable; HR re-enters them), breach procedure.
- `docs/TASKS.md`: items for RB-05..RB-08 and an owner item "set `HR_DATA_KEY`".
- `docs/ACCEPTANCE.md`: rows for the HR access matrix, audit, reveal, export.
- Red-team checklist for HR: IDOR on `/people/[id]`, tier 2 in any loader payload, reveal without audit, audit log
  tampering, CSV injection, manager-of-wrong-employee approval, HR flag escalation via form tampering, logging of values.

## 10. Prerequisites and owner actions

- **You:** run `wrangler secret put HR_DATA_KEY` (value: 32 random bytes in base64; the runbook gives a command) before
  tier 2 can be used. Keep a copy in the company password manager; there is no recovery.
- **You:** pick the HR user(s), answer the decisions above, supply the 2026-2027 holiday list when RB-06 ships.
- No new Cloudflare resources. R2 is used only from Phase 2 (documents vault).

## 11. Delivery estimate (engineer cycles, rough)

RB-05 large (new access model, crypto, audit); RB-06 large (ledger, concurrency, date maths); RB-07 medium;
RB-08 large (touches RB-01 hot paths and board). Each runs the full pipeline: engineer, QA, red team (RB-05, RB-06 and
RB-08 mandatory).
