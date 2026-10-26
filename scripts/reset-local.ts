import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { assertLocalOnly, localStateDir } from './local-guard.ts';

// Local only: deletes the local D1 state, then migrates and seeds it again.
const args = process.argv.slice(2);
assertLocalOnly(args);
const root = resolve('.wrangler');
const target = resolve(localStateDir(), 'v3', 'd1');
if (!target.startsWith(root + sep)) throw new Error(`Refusing: ${target} is outside ${root}`);

rmSync(target, { recursive: true, force: true });
console.log(`Removed local D1 state at ${target}`);
execFileSync('node', ['scripts/migrate-local.ts', ...args], { stdio: 'inherit' });
execFileSync('node', ['scripts/seed-local.ts', ...args], { stdio: 'inherit' });
