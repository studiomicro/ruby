# RB-07 Onboarding and offboarding checklists — PRD

Risk tier: **Medium** (new tables and role-based visibility; no money, no sensitive identifiers, no crypto; reuses RB-05 access model). Engineer + QA; red team optional (visibility matrix only).

Depends on: **RB-05** (employees, manager tree, `requireHr`, audit). Independent of RB-06. Context: `docs/features/rb-05-hrm-roadmap.md`.

## Goal

When someone joins or leaves, HR starts a checklist from a reusable template. Every item has an owner (HR, the manager, the employee, or a named person) and a due date, so laptop, accounts, contract signing and access removal do not get forgotten, and everyone can see what is theirs to do.

## Owner decisions (proposed defaults)

1. Item owner kinds: `hr` (any HR can complete), `manager` (the employee's manager's user), `employee` (the employee's linked user), `user` (one named active user).
2. Due dates are relative to an anchor: the employee's `start_on` for onboarding, `end_on` for offboarding (or a date HR picks when the employee has none). Offset range -30..+365 days.
3. The leaving employee does not see their offboarding run; the new hire does see onboarding. [roadmap 13]
4. Finishing an offboarding run does not terminate the employee or deactivate the account; a seeded template item reminds the admin. [roadmap 16]
5. No notifications; the "To do" page shows assigned items with an overdue count badge.
6. Limits: 20 templates, 40 items per template, 2 open runs per employee (one onboarding, one offboarding), 500 chars per description.
7. Templates are managed by HR; no built-in templates ship (the engineer's fixtures are test data only).

## Scope

### Migration `0004_onboarding.sql`

```
checklist_templates(
  id text PK, name text NOT NULL, kind text NOT NULL CHECK (kind IN ('onboarding','offboarding')),
  description text NOT NULL DEFAULT '',
  created_by text NOT NULL REFERENCES users(id), created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer)
  INDEX (kind, deleted_at)

checklist_template_items(
  id text PK, template_id text NOT NULL REFERENCES checklist_templates(id),
  position integer NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
  owner_kind text NOT NULL CHECK (owner_kind IN ('hr','manager','employee','user')),
  owner_user_id text REFERENCES users(id),
  due_offset_days integer NOT NULL CHECK (due_offset_days BETWEEN -30 AND 365),
  created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer)
  UNIQUE INDEX (template_id, position) WHERE deleted_at IS NULL

checklist_runs(
  id text PK, employee_id text NOT NULL REFERENCES employees(id),
  template_id text REFERENCES checklist_templates(id),
  kind text NOT NULL CHECK (kind IN ('onboarding','offboarding')),
  name text NOT NULL, anchor_on text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','canceled')),
  created_by text NOT NULL REFERENCES users(id), created_at integer NOT NULL, updated_at integer NOT NULL, completed_at integer)
  UNIQUE INDEX checklist_runs_open_uq ON checklist_runs(employee_id, kind) WHERE status = 'open'

checklist_run_items(
  id text PK, run_id text NOT NULL REFERENCES checklist_runs(id),
  position integer NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
  owner_kind text NOT NULL CHECK (owner_kind IN ('hr','manager','employee','user')),
  owner_user_id text REFERENCES users(id),
  due_on text NOT NULL,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done','skipped')),
  note text NOT NULL DEFAULT '',
  done_by text REFERENCES users(id), done_at integer,
  created_at integer NOT NULL, updated_at integer NOT NULL)
  INDEX (run_id, position), INDEX (owner_user_id, status, due_on)
```

Run items are a **snapshot** of the template at start: later template edits never change running checklists. Add `HR_AUDIT_ACTIONS`: `checklist_start`, `checklist_cancel`. Add enums `CHECKLIST_KINDS`, `CHECKLIST_OWNER_KINDS`, `CHECKLIST_RUN_STATUSES`, `CHECKLIST_ITEM_STATUSES`.

### Shared-file edits

- App shell: nav link "Onboarding" (all users: "To do" tab; HR sees all tabs). Badge: count of overdue `todo` items the viewer can complete (one indexed query).
- RB-05 profile page: for HR and the manager, a card "Checklists" listing open runs with progress and a "Start onboarding / offboarding" button (HR).

### Routes (`src/routes/(app)/onboarding/`)

| Route | Who | Purpose |
|---|---|---|
| `+page.*` | any active user | "To do": items I can complete, grouped Overdue / This week / Later; tab "Runs" for HR and managers |
| `runs/[id]/+page.*` | HR, manager of the employee, onboarding: the employee, item owners (their items only) | Run detail; actions `complete`, `reopen`, `skip`, `note` per item; `finish`, `cancel` |
| `runs/new/+page.*` | HR | Start a run: employee, template, anchor date; owner assignments for `user` items shown and editable |
| `templates/+page.*` | HR | Template list and create |
| `templates/[id]/+page.*` | HR | Edit template and items; actions `rename`, `itemAdd`, `itemUpdate`, `itemMove`, `itemDelete`, `archive` |

### Page structure

- **To do**: rows (item title, employee name, run name, due date, overdue chip, Complete button). A user with no items sees "Nothing to do".
- **Run detail**: header (employee, kind, anchor date, progress "7 of 12 done"), items in position order with owner label (resolved name), due date, status, Complete / Skip / Reopen buttons where permitted, note field (0-500). Finish run button enabled when no `todo` items remain; Cancel run (HR) with confirm.
- **Template editor**: ordered items, add/edit/move up/down/delete; preview of due dates for a sample anchor date. Move up/down are plain buttons (no drag required).
- **Start run**: employee select (active employees without an open run of this kind), template select (same kind), anchor date default per decision 2; summary preview before confirming.

### Server modules (`src/lib/server/checklists/`)

`validation.ts` (`CHECKLIST_LIMITS`), `repo.ts` (`listTodo`, `getRun`, `startRun`, `setItemStatus`, `finishRun`, `cancelRun`, template and item CRUD), `permissions.ts` (`canActOnItem(actor, run, item, employee, managerUserId)`, `canViewRun`), `resolve.ts` (pure: `resolveOwnerUserId(item, employee, managerUserId)` → user id or null for the `hr` pool), `dates.ts` (pure `dueFromOffset(anchorOn, offsetDays)`).

### Validation (`CHECKLIST_LIMITS`)

- Template `name` 1-80, `description` 0-500; max 20 live templates; max 40 live items per template.
- Item `title` 1-120 single line, `description` 0-500, `owner_kind` in enum, `owner_user_id` required iff `owner_kind='user'` and must be an active user; `due_offset_days` integer -30..365.
- Run: `employee_id` a live active-status employee; `template_id` a live template of the same kind; `anchor_on` valid date 2000-01-01..2100-12-31; for `employee`/`manager` items the resolved user must exist, otherwise the item is created with `owner_user_id` null and shown as "No account linked" (HR can complete it instead; not an error).
- Item `note` 0-500. Template with 0 items cannot start a run.
- All text trimmed, control and bidi characters stripped; rendered as plain text, never Markdown.

### Authorization per action

| Action | Rule |
|---|---|
| Template CRUD, start run, cancel run | `requireHr` |
| View run | HR; manager of the employee; the employee only for onboarding; any resolved item owner (sees run header and own items only) |
| Complete / skip / reopen / note an item | HR; or the resolved owner of that item (`manager`, `employee`, `user`) |
| Finish run | HR or the employee's manager (all items non-`todo`) |
| To do page | `requireUser`, own items only |

Not-allowed and not-found both answer 404. Archived (soft-deleted) templates cannot start runs but running copies keep working.

### Concurrency

- **Start run**: one `db.batch`: `INSERT INTO checklist_runs … SELECT … WHERE EXISTS (employee live) AND EXISTS (template live, same kind)`; `INSERT INTO checklist_run_items … SELECT … FROM checklist_template_items i WHERE i.template_id=:t AND i.deleted_at IS NULL` with `due_on` computed in the application and bound via a JSON parameter (`json_each`, avoids the 100-parameter limit) or computed in SQL with `date(:anchor, '+' || offset || ' days')`; audit row `checklist_start` guarded by `EXISTS (run)`. The partial unique index `checklist_runs_open_uq` is the arbiter for "one open run per employee and kind": violation → "An open checklist of this kind already exists".
- **Item status**: `UPDATE checklist_run_items SET status, done_by, done_at, updated_at=max(:now,:expected+1) WHERE id=:id AND updated_at=:expected AND EXISTS (SELECT 1 FROM checklist_runs WHERE id=run_id AND status='open')`; 0 changes → re-read; already in requested state → success (idempotent); different → 409 "Changed meanwhile".
- **Finish**: `UPDATE checklist_runs SET status='completed', completed_at WHERE id AND status='open' AND NOT EXISTS (SELECT 1 FROM checklist_run_items WHERE run_id=… AND status='todo')`; 0 changes → re-read to say which.
- **Cancel**: guarded on `status='open'`, plus audit row.
- **Template item edits**: position uniqueness via swap in one batch; `itemMove` swaps positions with a temporary negative position inside the batch; item-count limit via `INSERT … SELECT … WHERE (SELECT count(*) …) < 40`. Template edits use `expectedUpdatedAt`.
- **Terminate (RB-05)**: does not touch runs. A run for a terminated employee can still be finished.

### States

Skeletons; To do empty "Nothing to do"; Runs empty "No checklists yet"; templates empty "Create your first template"; per-item pending/spinner states; overdue chip; run finished banner; archived-run read-only; errors inline; success after server confirmation.

## Acceptance criteria

1. Signed-out and deactivated users are refused on every route and action.
2. HR can create a template with 1 to 40 items; the 41st item and 21st template are refused; boundary lengths accepted, 121-char title rejected.
3. `user` items require an active user id; other owner kinds ignore a posted `owner_user_id`.
4. Starting a run copies every live template item with `due_on = anchor + offset` (including negative offsets, month ends, leap day); later template edits do not change the run; a template with no items is refused.
5. A second open run of the same kind for the same employee is refused (concurrent start: exactly one succeeds); an onboarding and an offboarding run may coexist.
6. Owner resolution: `manager` items go to the manager's linked user; `employee` items to the employee's linked user; when no account exists the item is unowned and only HR can complete it.
7. The item owner (manager, employee, named user) and HR can complete their item; anyone else gets 404 and nothing changes; completing twice is idempotent; skip and reopen follow the same rule.
8. The employee sees their onboarding run but not their offboarding run; a manager sees runs of direct reports only; an item owner sees only their items and the run header; a plain member sees nothing.
9. Finish succeeds only when no item is `todo`; cancel by non-HR refused; canceled and completed runs reject item changes.
10. To do page lists exactly the viewer's `todo` items on open runs, grouped by due date relative to today in `TEAM_TIME_ZONE`; badge equals overdue count.
11. Start and cancel write audit rows (`checklist_start`, `checklist_cancel`) with the employee id and no free text.
12. Item text and notes render as plain text (`<script>` inert); no `{@html}`.
13. Archiving a template does not affect running copies; archived templates are not offered for new runs.
14. Template item reorder is stable under concurrent moves (no duplicate positions; unique index never violated).
15. Terminating an employee leaves their open runs usable.
16. No employee personal data beyond name appears in logs or notifications; no tier 1/2 data in this module's payloads.
17. All forms work without JS; 360 px layout without horizontal scroll; every control labelled.
18. `npm run check`, lint and tests pass; migration `0004_onboarding.sql` applies on an existing database.

## Test plan

Unit: `dueFromOffset` table (negative, +365, leap day, month end); `resolveOwnerUserId` matrix; `canActOnItem` and `canViewRun` matrices; validation boundaries.
Integration (`openLocalD1`, `fakeEvent`, `seed-hr.ts` and `seed-checklists.ts`): start run snapshot; concurrent start; concurrent complete; finish guard; permission matrix for HR, manager, employee, named user, outsider, deactivated user; template edit after run start; position swap race; archive behaviour; To do grouping and badge.
Manual: no-JS flows, phone layout, a 40-item template.

## Out of scope

E-mail or in-app notifications and reminders; creating RB-01 tasks from items; attachments or e-signatures on items; conditional items; recurring runs; per-department template routing; auto-terminate or auto-deactivate; checklist comments; reporting; templates shared across departments with permissions; item dependencies.

## Architecture notes

Reuse RB-05 `requireHr`, `auditStatement`, `employees`, `viewerRelation`; `todayIn` (`src/lib/server/tasks/dates.ts`); `newId`; `errorLabel`. New trees: `src/lib/server/checklists/**`, `src/routes/(app)/onboarding/**`, `test/helpers/seed-checklists.ts`. Edits to shared files limited to nav, the RB-05 profile card, `enums.ts`, `schema.ts`.

## Prerequisites

RB-05 merged. No variables or bindings.

## Schema additions

Migration `0004_onboarding.sql` as above.

## Tracker impact

New `docs/TASKS.md` item "RB-07 Onboarding and offboarding". `docs/ACCEPTANCE.md`: run visibility matrix (Automated), snapshot behaviour (Automated).
