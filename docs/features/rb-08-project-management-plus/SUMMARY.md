# RB-08 Project management extras — summary

**Status: complete** (2026-10-26).

Labels, checklists, milestones, advisory WIP limits, renamed/hidden board columns, saved views and bulk edit on top
of RB-01.

- QA: PASS (no defects). Red team: PASS with 3 Low (manager rule only checked before the write; bulk assignment
  notification burst; 8 KiB form cap refusing valid long descriptions) — fixed in cycle 2.
- Migration: `0010_pm_plus.sql` (regenerated on top of `0002_hr_core`; SQL unchanged).
- Known flake: kit `Select` picks before hydration reset (fixed in RB-10).
