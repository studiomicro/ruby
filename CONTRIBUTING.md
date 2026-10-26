# Contributing to Ruby

Thanks for helping. By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE),
the same as the project. There is no separate CLA or DCO sign-off.

## Setup

```sh
npm ci
npm run db:reset:local
npm run db:seed:local
npm run dev
```

Node 22 or newer. Seed account: `admin@example.test` / `ruby-local-demo` (local only). Never commit `.dev.vars`,
`.deploy.env`, keys, real ids or real personal data.

## Before you open a pull request

Run `npm run gates` (type check, lint, tests, build). All four must pass. The pull request template lists the rest.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`, `fix(scope): ...`,
`docs: ...`, `chore: ...`, `test: ...`. One logical change per commit.

## Rules the code relies on

- **Access.** Call `requireUser(event)` or `requireAdmin(event)` first in every load, form action, API route and
  download. Hidden and missing ids give the same answer.
- **Time and deletes.** Timestamps are UTC milliseconds. User-data rows are soft deleted (`deleted_at`); live queries
  filter `deleted_at IS NULL`.
- **Markdown** is rendered only through `src/lib/shared/markdown.ts`. Never use `{@html}` on anything else.
- **Search tables** (`pages_fts`, `tasks_fts`) are written only by the migration triggers.
- **Schema.** A new numbered file under `migrations/` plus `src/lib/server/db/schema.ts`. Never edit an applied
  migration.
- **Attachments.** Server-generated R2 keys, metadata in D1, download only through the authorised route.
- **Tests.** Every non-trivial branch, parser or policy check gets a Vitest test. Fixtures are fictional.
- **Dependencies.** Production dependencies must carry a permissive licence (`test/licences.test.ts` checks).
- **Layout.** Server code in `src/lib/server`, shared pure code in `src/lib/shared`.
- **No deployment identifiers.** Use `example.test` / `example.com` in tests and docs. Account ids, database ids,
  hostnames and tokens of a real deployment never enter the repository (`docs/SELF_HOSTING.md`).

More detail: [CLAUDE.md](CLAUDE.md) and [docs/ENGINEERING_CHECKLIST.md](docs/ENGINEERING_CHECKLIST.md).

## Reporting problems

Bugs and ideas: open an issue from the templates. Security issues: see [SECURITY.md](SECURITY.md).
