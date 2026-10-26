import { execFileSync } from 'node:child_process';
import { assertLocalOnly, localStateDir } from './local-guard.ts';
import { SEED_PASSWORD, SEED_USERS, seedStatements } from './seed-data.ts';

// Local only: fictional review data in the local D1 `ruby` (never --remote, never production).
assertLocalOnly(process.argv.slice(2));
execFileSync(
	'npx',
	[
		'wrangler',
		'd1',
		'execute',
		'ruby',
		'--local',
		'--persist-to',
		localStateDir(),
		'--command',
		seedStatements(Date.now()).join(';\n')
	],
	{ stdio: 'inherit', env: { ...process.env, CI: 'true' } }
);
console.log(
	`Seeded local accounts ${SEED_USERS.map((u) => u.email).join(', ')} (password: ${SEED_PASSWORD}).`
);
