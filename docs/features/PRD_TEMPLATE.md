<!--
HOW TO USE THIS TEMPLATE
- Copy it to docs/features/<rb-nn-slug>/PRD.md and replace every <placeholder>.
- Keep all 16 numbered sections and their order. If a section does not apply, write "None." and one line why. Never delete it.
- Prefer tables and lists to prose. Keep paragraphs to 3 sentences. Keep lines under ~160 characters (table rows and URLs excepted).
- Cite current code as `path:line`. Name files, routes, limits and migration numbers exactly.
- Every acceptance criterion is a checkbox "- [ ] ACn [A|M|P] ..." and is testable. Levels follow docs/ACCEPTANCE.md.
- Every owner-visible trade-off is a row in section 14 with a proposed default. The owner answers once, before the build.
- Delete this comment block and the italic hints in the final PRD.
-->

# RB-NN Feature name

> One-line summary: what this ships and for whom, in plain words.

## Summary

| Field | Value |
| --- | --- |
| ID | RB-NN |
| Status | Draft / Approved / Building / Shipped |
| Risk tier | Small / Medium / Large (why, in one line) |
| Release version | x.y.z (release note `src/lib/content/releases/x.y.z.md`) |
| Migration | none, or `00NN_name.sql` |
| Depends on | RB-xx (hard), RB-yy (soft) |
| Owner | name or role |
| Date | YYYY-MM-DD |

## Contents

1. [Goal and user value](#1-goal-and-user-value)
2. [Scope](#2-scope)
3. [Current behaviour this builds on](#3-current-behaviour-this-builds-on)
4. [Design](#4-design)
5. [Routes and UI](#5-routes-and-ui)
6. [Data and migrations](#6-data-and-migrations)
7. [Limits](#7-limits)
8. [Authorization](#8-authorization)
9. [Concurrency and failure states](#9-concurrency-and-failure-states)
10. [Mobile and accessibility](#10-mobile-and-accessibility)
11. [Security and privacy](#11-security-and-privacy)
12. [Acceptance criteria](#12-acceptance-criteria)
13. [Test plan](#13-test-plan)
14. [Owner decisions](#14-owner-decisions)
15. [Out of scope / later](#15-out-of-scope--later)
16. [Release note draft](#16-release-note-draft)

## 1. Goal and user value

Why this matters for the team, in one short paragraph. Name the user, the problem and the outcome.

## 2. Scope

**In**

- Concrete thing that will be built (route, module, table, UI state).

**Out**

- Thing that will not be built in this pass.

## 3. Current behaviour this builds on

Cite before changing.

- `path/to/file.ts:12-30`: what it does today.

## 4. Design

### 4.1 First design topic

Short paragraphs and lists. State the decision, then the reason.

### 4.2 Second design topic

```ts
// Only signatures or shapes that are load-bearing. No implementation.
```

> [!NOTE]
> Use a NOTE for context the engineer should not miss.

> [!WARNING]
> Use a WARNING for a rule that must not be weakened (security, data loss, shared locks).

## 5. Routes and UI

| Route | Who | What |
| --- | --- | --- |
| `/example` | member | What the page shows or does, and its states (loading, empty, error, saving, success). |

## 6. Data and migrations

| Table | Change | Notes |
| --- | --- | --- |
| `example` | add / alter / none | Columns, keys, indexes, soft delete. |

```sql
-- migrations/00NN_name.sql (never edit an applied migration)
```

## 7. Limits

| Limit | Value | Where enforced |
| --- | --- | --- |
| Example cap | 10 per user | server action, test name |

## 8. Authorization

Every load, action, API route and download starts with `requireUser` or `requireAdmin`.

| Action | Signed-out | Member | Admin | HR / other |
| --- | --- | --- | --- | --- |
| Example action | refused | allowed | allowed | n/a |

## 9. Concurrency and failure states

- Concurrent edits: compare `updated_at`, answer "changed meanwhile".
- Partial failure: order of writes, what is rolled back.
- Missing prerequisite (variable, binding): exact behaviour.

## 10. Mobile and accessibility

- Viewports checked (402x874, 440x956, 360x800), safe areas through `--sai-*` only, 44 px targets, inputs >= 16 px.
- Keyboard, focus, roles, contrast, reduced motion.

## 11. Security and privacy

- What data is touched, who can see it, what is logged (never page text, comment text, attachment names or HR values).
- Threats considered and the control for each.

## 12. Acceptance criteria

Levels per `docs/ACCEPTANCE.md`: [A] Automated, [M] Mocked, [P] Pass (manual on a real device).

- [ ] AC1 [A] Given X, when Y, then Z.
- [ ] AC2 [A] A signed-out request and a deactivated user are refused on every load, action and download touched.

## 13. Test plan

| Layer | File | Covers |
| --- | --- | --- |
| Vitest unit | `src/lib/shared/example.test.ts` | AC1 |
| Vitest integration (local D1) | `test/example.test.ts` | AC2 |
| Playwright | `e2e/example.spec.ts` | AC3 |
| Manual [P] | n/a | AC4, device names and versions recorded |

## 14. Owner decisions

| # | Decision | Options | Default | Answer |
| --- | --- | --- | --- | --- |
| O1 | The trade-off, in a question | A / B | **A** | pending |

## 15. Out of scope / later

- Deferred item, and what would trigger it.

## 16. Release note draft

> Plain English, for people using Ruby. What is new, how to use it, what it does not do.
