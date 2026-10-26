# RB-11 Release notes and reload — summary

**Status: complete** (2026-10-26).

A What's new page, a New dot for unread notes, and an update banner with Reload after each deploy; unsaved input
is never discarded without asking.

- Review (QA + narrow security): FAIL (the banner covered the phone More sheet) → fixed (z-index under the tab bar's
  stacking context) with e2e; a link followed after an update with unsaved input now asks first too.
- Version 0.2.0; deploys refuse when package.json, APP_VERSION and the newest notes disagree.
- No migration.
