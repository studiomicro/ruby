# RB-06 Time off — summary

**Status: complete** (2026-10-26, released as v0.3.0).

Leave requests, balances, approvals, team calendar, holidays and HR settings on top of RB-05 employees.

- Owner answers: UU default leave; audited self-approval only while no manager, no other active HR user and no
  other active admin exists.
- QA: PASS with D1 (kit Select hydration — fixed in RB-10) and D2 (owner's own requests undecidable — fixed by
  self-approval). Red team: PASS with 6 Low → fixed in cycle 2 → re-check PASS with N1 (admin fallback alongside
  self-approval) → fixed in cycle 3.
- Migration: `0003_time_off.sql` (journal idx 4; snapshot `0011_snapshot.json`).
- Owner step: enter the public holidays in Time off › Settings.
