# Self-hosting Ruby

Ruby runs on one Cloudflare Worker with one D1 database and one R2 bucket. A free Cloudflare account is enough to start;
check Cloudflare's current limits for Workers CPU time, because password hashing and Markdown rendering use CPU. You
need Node 22 or newer, and a domain on Cloudflare for the custom domain route.

The repository is public and holds only placeholders. Your real ids and hostname live in a gitignored `.deploy.env`
(or in environment variables); `npm run deploy` renders them into a temporary `wrangler.deploy.generated.jsonc`, uses
it for every Wrangler call, and deletes it afterwards. Nothing is printed and nothing is committed.

## 1. Install and log in

```sh
npm ci
npx wrangler login
```

## 2. Create the database and the bucket

```sh
npx wrangler d1 create ruby
npx wrangler r2 bucket create ruby-files
```

Keep the bucket private: no public access and no custom domain on the bucket. Note the `database_id` that the first
command prints.

## 3. Fill `.deploy.env`

```sh
cp .deploy.env.example .deploy.env
chmod 600 .deploy.env
```

| Variable                  | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID`   | your account id (dashboard sidebar, 32 hex characters)                   |
| `RUBY_D1_DATABASE_ID`     | the `database_id` from step 2                                            |
| `RUBY_APP_HOST`           | the host the app is served on, for example `ruby.your-domain.example`    |
| `RUBY_ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com`; needed unless `RUBY_ACCESS_DISABLED=1`    |
| `RUBY_ACCESS_AUD`         | the Access application's AUD tag; needed unless `RUBY_ACCESS_DISABLED=1` |
| `RUBY_ACCESS_DISABLED`    | leave empty to require Access; `1` if no Access application is used      |

The deploy refuses to run on a missing or malformed value or on a leftover placeholder.

## 4. First deploy

```sh
npm run gates
node scripts/deploy.ts --dry-run   # renders, builds, wrangler deploy --dry-run; changes nothing remote
npm run deploy                     # bookmark, remote migrations, build, deploy
```

The deploy needs a clean git tree (commit your changes first) and attaches `RUBY_APP_HOST` to the Worker as a custom
domain.

## 5. Set the HR data key

Employee data in tiers 2 and 3 (national id, tax and social-security numbers, bank account, address, salary) is
encrypted under the Worker secret `HR_DATA_KEY`. Without it that data is read-only.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
node scripts/deploy.ts --write-config
npx wrangler secret put HR_DATA_KEY -c wrangler.deploy.generated.jsonc
rm wrangler.deploy.generated.jsonc
```

Store the key in a password manager first: there is no recovery, and a lost key makes the stored values unreadable.

## 6. Cloudflare Access (optional but recommended)

In Zero Trust, add a self-hosted application for `RUBY_APP_HOST` with an Allow policy for your team (no Bypass or
Everyone rule). Copy the Application Audience (AUD) tag and your team domain into `.deploy.env`
(`RUBY_ACCESS_AUD`, `RUBY_ACCESS_TEAM_DOMAIN`), keep `RUBY_ACCESS_DISABLED` empty, and deploy again. The Worker
verifies the Access JWT itself and answers 503 while the two values are empty. Without Access, set
`RUBY_ACCESS_DISABLED=1`: you then rely on the invite-only accounts alone.

## 7. First admin

While no user exists, open `https://<RUBY_APP_HOST>/setup` and create the first account; it becomes the admin.
`/setup` answers 404 once a user exists. Invite everyone else from `/admin/users` and send each person their link.

## Updating

Pull, run `npm run gates`, commit, and run `npm run deploy`. Migrations are applied by the deploy, after a D1 Time
Travel bookmark that you can restore to. Rollback and routine operations: [RUNBOOK.md](RUNBOOK.md).

## Local development

See the quick start in the [README](../README.md). Local runs use a local D1 and need no Cloudflare account.
