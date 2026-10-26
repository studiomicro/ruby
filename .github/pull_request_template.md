## What and why

## Checklist

- [ ] `npm run gates` passes (check, lint, test, build)
- [ ] Tests added or updated (admin, member and signed-out where access is touched)
- [ ] Every new load, action, route and download calls `requireUser` or `requireAdmin`
- [ ] User Markdown is rendered only through `src/lib/shared/markdown.ts`
- [ ] Deletes are soft (`deleted_at`) and live queries filter them; search stays consistent
- [ ] Schema changes are a new numbered migration plus the Drizzle schema
- [ ] No secrets or real personal data in the diff
