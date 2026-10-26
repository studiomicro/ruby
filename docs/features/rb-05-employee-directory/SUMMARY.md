# RB-05 Employee directory — summary

**Status: complete** (2026-10-26).

People directory, profiles, org chart, HR capability, encrypted sensitive fields (NIK, NPWP, BPJS, bank) and
salary history, audited reveal, audit log and CSV export.

- Owner answers: salary stored HR-only; ID/bank numbers encrypted; the owner is the only HR user.
- QA: PASS (F1 e2e flakes fixed). Red team: PASS with 3 Low (non-HR admin saw names of terminated employees in the
  audit filter; INSERT OR REPLACE could rewrite audit/salary rows; restore could close a manager cycle) — all fixed
  in cycle 2, plus HR cleared on account disable and `key_version` checked on decrypt.
- Migration: `0002_hr_core.sql`.
- Owner step: set `HR_DATA_KEY` (docs/RUNBOOK.md); until then sensitive fields show "Not configured".
