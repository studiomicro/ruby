import { execFileSync } from 'node:child_process';
import { assertLocalOnly, localStateDir } from './local-guard.ts';

// Local only: applies migrations/ to the local D1 `ruby` under .wrangler/ (never --remote; see npm run deploy).
assertLocalOnly(process.argv.slice(2));
execFileSync(
	'npx',
	['wrangler', 'd1', 'migrations', 'apply', 'ruby', '--local', '--persist-to', localStateDir()],
	{ stdio: 'inherit', env: { ...process.env, CI: 'true' } }
);
