/**
 * The production deploy (`npm run deploy`, docs/RUNBOOK.md › Routine deploy), the only way production changes.
 * Ruby has one environment, so there is no generated config: `wrangler.jsonc` is used as committed.
 *
 * Refuses to start while the D1 `database_id` is still the placeholder or the git working tree is not clean (every
 * deploy is a commit), or when package.json's version, `APP_VERSION` and the newest release notes disagree.
 * Then, stopping at the first failure:
 *   1. read the D1 Time Travel bookmark (`wrangler d1 time-travel info ruby`) and print it: the rollback point;
 *   2. apply remote migrations (`wrangler d1 migrations apply ruby --remote`);
 *   3. build (`vite build`);
 *   4. `wrangler deploy`.
 * `--dry-run` skips steps 1 and 2 (nothing remote is read or changed) and passes `--dry-run` to `wrangler deploy`.
 */
/**
 * The production deploy (`npm run deploy`, docs/RUNBOOK.md › Routine deploy), the only way production changes.
 * The repository is public, so the committed `wrangler.jsonc` carries placeholders for the account id, the D1 id, the
 * app's custom domain and the Cloudflare Access settings. The real values come from the environment or, for any unset
 * there, from the gitignored `.deploy.env` (`.deploy.env.example` lists them). They are written into a temporary,
 * gitignored `wrangler.deploy.generated.jsonc` next to each config, which every wrangler call uses (migrations, Time
 * Travel, deploy) and which is removed afterwards. No value is ever printed.
 *
 * Refuses to start on a missing or malformed value, a leftover placeholder in the rendered config, a git working tree
 * that is not clean (every deploy is a commit), or when package.json's version, `APP_VERSION` and the newest release
 * notes disagree. Then, stopping at the first failure:
 *   1. read the D1 Time Travel bookmark (`wrangler d1 time-travel info ruby`) and print it: the rollback point;
 *   2. apply remote migrations (`wrangler d1 migrations apply ruby --remote`);
 *   3. build (`vite build`);
 *   4. `wrangler deploy`.
 * `--dry-run` skips steps 1 and 2 (nothing remote is read or changed) and passes `--dry-run` to `wrangler deploy`.
 * `--write-config` only writes the generated config and keeps it (no wrangler call), for hand-run commands such as a
 * Time Travel restore, `wrangler secret put` or `wrangler rollback` (`-c wrangler.deploy.generated.jsonc`).
 * The generated files are also removed on SIGINT/SIGTERM and, when left over from an earlier killed run, at the start.
 *
 * Another Worker (RB-09's `workers/jobs/wrangler.jsonc`) joins by adding its path to `CONFIGS` and a `deploy(...)`
 * step to `buildSteps`; the renderer replaces only the placeholders a config contains.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appVersionOf, parseReleases, versionProblems } from '../src/lib/shared/releases.ts';

export const CONFIGS = ['wrangler.jsonc'] as const;
export const DEPLOY_ENV_FILE = '.deploy.env';
export const DATABASE = 'ruby';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Every real value a deploy needs, with the shape it must have. */
export const DEPLOY_VARS = {
	CLOUDFLARE_ACCOUNT_ID: HEX32,
	RUBY_D1_DATABASE_ID: UUID,
	RUBY_APP_HOST: HOST
} as const;
/**
 * Access settings. `RUBY_ACCESS_DISABLED` is "" (Access required, the default) or "1". While Access is required, the
 * team domain and AUD tag are required too: without them the deployed host would answer 503 to everyone.
 */
export const ACCESS_VARS = {
	RUBY_ACCESS_TEAM_DOMAIN: HOST,
	RUBY_ACCESS_AUD: HEX64,
	RUBY_ACCESS_DISABLED: /^1?$/
} as const;
export type DeployValues = Record<keyof typeof DEPLOY_VARS, string> &
	Partial<Record<keyof typeof ACCESS_VARS, string>>;

const PLACEHOLDER_ACCOUNT = /"account_id"\s*:\s*"0{32}"/g;
const PLACEHOLDER_D1 = /0{8}-0{4}-4000-8000-0{12}/g;
const PLACEHOLDER_HOST = 'ruby.example.invalid';
const PLACEHOLDER_TEAM = 'team.example.invalid';
const PLACEHOLDER_AUD = /"ACCESS_AUD"\s*:\s*"0{64}"/g;
const ACCESS_DISABLED = /"ACCESS_DISABLED"\s*:\s*""/g;
const REAL_D1 =
	/"database_id"\s*:\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/;

/** The temporary config written next to `config` for the deploy (gitignored). */
export function generatedPath(config: string): string {
	return join(dirname(config), 'wrangler.deploy.generated.jsonc');
}

/** `KEY=value` lines; blank lines and `#` comments are ignored; one pair of surrounding quotes is dropped. */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split('\n')) {
		const line = raw.trim().replace(/^export\s+/, '');
		const eq = line.indexOf('=');
		if (line.startsWith('#') || eq < 1) continue;
		out[line.slice(0, eq).trim()] = line
			.slice(eq + 1)
			.trim()
			.replace(/^(["'])(.*)\1$/, '$2');
	}
	return out;
}

/** Each value from the environment, else from the file. Problems name the variable, never its value. */
export function resolveDeployValues(
	env: Record<string, string | undefined>,
	file: Record<string, string>
): { values: DeployValues; problems: string[] } {
	const values = {} as DeployValues;
	const problems: string[] = [];
	const pick = (name: string) => env[name] || file[name] || '';
	const check = (name: string, shape: RegExp, required: boolean) => {
		const value = pick(name);
		if (!value) {
			if (required) problems.push(`${name} is not set (environment or ${DEPLOY_ENV_FILE})`);
			return;
		}
		if (
			!shape.test(value) ||
			/^(0+|0{8}-0{4}-4000-8000-0{12})$/.test(value) ||
			value.endsWith('.example.invalid')
		)
			problems.push(`${name} does not have the expected form`);
		values[name as keyof DeployValues] = value;
	};
	for (const [name, shape] of Object.entries(DEPLOY_VARS)) check(name, shape, true);
	for (const [name, shape] of Object.entries(ACCESS_VARS)) {
		if (name === 'RUBY_ACCESS_DISABLED') {
			const value = pick(name);
			if (!shape.test(value)) problems.push(`${name} must be empty or 1`);
			else if (value) values.RUBY_ACCESS_DISABLED = value;
		} else check(name, shape, pick('RUBY_ACCESS_DISABLED') !== '1');
	}
	return { values, problems };
}

/** The config with every placeholder it contains replaced by the real value. */
export function renderDeploy(text: string, values: DeployValues): string {
	return text
		.replace(PLACEHOLDER_ACCOUNT, `"account_id": "${values.CLOUDFLARE_ACCOUNT_ID}"`)
		.replace(PLACEHOLDER_D1, values.RUBY_D1_DATABASE_ID)
		.replaceAll(PLACEHOLDER_HOST, values.RUBY_APP_HOST)
		.replaceAll(PLACEHOLDER_TEAM, values.RUBY_ACCESS_TEAM_DOMAIN ?? '')
		.replace(PLACEHOLDER_AUD, `"ACCESS_AUD": "${values.RUBY_ACCESS_AUD ?? ''}"`)
		.replace(ACCESS_DISABLED, `"ACCESS_DISABLED": "${values.RUBY_ACCESS_DISABLED ?? ''}"`);
}

/**
 * One problem per reason the deploy must not start (pure): the rendered configs, `git status --porcelain` and,
 * optionally, the version sources. Reports file names and reasons, never values.
 */
export function deployProblems(
	rendered: Record<string, string>,
	gitStatus: string | null,
	versions?: { packageVersion: string; latestRelease: string | undefined }
): string[] {
	const problems: string[] = [];
	for (const [file, text] of Object.entries(rendered)) {
		if (versions && file === CONFIGS[0])
			problems.push(...versionProblems({ ...versions, appVersion: appVersionOf(text) }));
		const left = [
			[/"account_id"\s*:\s*"0{32}"/, 'account_id'],
			[/0{8}-0{4}-4000-8000-0{12}/, 'D1 database_id'],
			[/example\.invalid/, 'host'],
			[/"ACCESS_AUD"\s*:\s*"0{64}"/, 'ACCESS_AUD']
		] as const;
		for (const [re, what] of left)
			if (re.test(text)) problems.push(`${file}: placeholder ${what} left after rendering`);
		if (file === CONFIGS[0] && !REAL_D1.test(text)) problems.push(`${file}: no D1 database_id`);
	}
	if (gitStatus === null) problems.push('git status failed: deploy from a git checkout');
	else if (gitStatus.trim() !== '')
		problems.push('the git working tree is not clean: commit or stash first');
	return problems;
}

/** The bookmark in `wrangler d1 time-travel info` output (JSON or text), or null. */
export function parseBookmark(stdout: string): string | null {
	return (
		/"bookmark"\s*:\s*"([0-9a-f-]+)"/.exec(stdout)?.[1] ??
		/bookmark[^0-9a-f]*([0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32})/i.exec(stdout)?.[1] ??
		null
	);
}

export type Step = { label: string; cmd: string; args: string[]; bookmark?: true };

export function buildSteps(dryRun: boolean): Step[] {
	const config = generatedPath(CONFIGS[0]);
	const deploy = (label: string, file: string): Step => ({
		label,
		cmd: 'npx',
		args: ['wrangler', 'deploy', '-c', generatedPath(file), ...(dryRun ? ['--dry-run'] : [])]
	});
	const remote: Step[] = [
		{
			label: 'D1 Time Travel bookmark (rollback point)',
			cmd: 'npx',
			args: ['wrangler', 'd1', 'time-travel', 'info', DATABASE, '-c', config, '--json'],
			bookmark: true
		},
		{
			label: 'Apply remote migrations',
			cmd: 'npx',
			args: ['wrangler', 'd1', 'migrations', 'apply', DATABASE, '-c', config, '--remote']
		}
	];
	return [
		...(dryRun ? [] : remote),
		{ label: 'Build', cmd: 'npx', args: ['vite', 'build'] },
		deploy('Deploy Worker', CONFIGS[0])
	];
}

const GENERATED = CONFIGS.map(generatedPath);
/** Exit codes after a signal, as a shell reports them (128 + signal number). */
export const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;

export function removeGenerated(paths: readonly string[] = GENERATED): void {
	for (const p of paths) rmSync(p, { force: true });
}

type SignalHost = {
	on(signal: keyof typeof SIGNAL_EXIT, handler: () => void): unknown;
	exit(code: number): void;
};

/**
 * On SIGINT/SIGTERM: pass the signal to the running wrangler call, delete the generated configs (they hold the real
 * ids) and exit with 130/143. A killed run never leaves them behind.
 */
export function cleanUpOnSignals(
	host: SignalHost,
	paths: readonly string[],
	running: () => ChildProcess | undefined
): void {
	for (const signal of Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[])
		host.on(signal, () => {
			running()?.kill(signal);
			removeGenerated(paths);
			host.exit(SIGNAL_EXIT[signal]);
		});
}

let child: ChildProcess | undefined;

/** Runs one command with the account id in its environment; resolves with its exit code and stdout (echoed when captured). */
function run(step: Step, capture: boolean): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const proc = spawn(step.cmd, step.args, {
			env: process.env,
			stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit']
		});
		child = proc;
		let out = '';
		const done = (code: number) => {
			child = undefined;
			resolve({ code, out });
		};
		proc.stdout?.on('data', (chunk: Buffer) => {
			out += chunk.toString('utf8');
			process.stdout.write(chunk);
		});
		proc.on('error', () => done(1));
		proc.on('close', (code) => done(code ?? 1));
	});
}

export async function runSteps(
	steps: Step[],
	runner: (step: Step, capture: boolean) => Promise<{ code: number; out: string }> = run
): Promise<number> {
	for (const [i, step] of steps.entries()) {
		console.log(`\n[${i + 1}/${steps.length}] ${step.label}\n$ ${step.cmd} ${step.args.join(' ')}`);
		const { code, out } = await runner(step, step.bookmark === true);
		if (code !== 0) {
			console.error(`deploy: step ${i + 1} failed (${step.label}); stopping.`);
			return 1;
		}
		if (!step.bookmark) continue;
		const bookmark = parseBookmark(out);
		if (!bookmark) {
			console.error('deploy: no Time Travel bookmark in the output; stopping before migrations.');
			return 1;
		}
		console.log(`deploy: Time Travel bookmark ${bookmark}`);
	}
	return 0;
}

const RELEASES_DIR = 'src/lib/content/releases';

/** package.json's version and the newest release file's, for the consistency check. */
function readVersions(): { packageVersion: string; latestRelease: string | undefined } {
	const files = Object.fromEntries(
		readdirSync(RELEASES_DIR)
			.filter((name) => name.endsWith('.md'))
			.map((name) => [name, readFileSync(`${RELEASES_DIR}/${name}`, 'utf8')])
	);
	return {
		packageVersion: (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
			.version,
		latestRelease: parseReleases(files)[0]?.version
	};
}

function gitStatus(): string | null {
	try {
		return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
	} catch {
		return null;
	}
}

async function main(argv: string[]): Promise<number> {
	const dryRun = argv.includes('--dry-run');
	const file = existsSync(DEPLOY_ENV_FILE)
		? parseEnvFile(readFileSync(DEPLOY_ENV_FILE, 'utf8'))
		: {};
	const { values, problems: missing } = resolveDeployValues(process.env, file);
	const rendered = Object.fromEntries(
		CONFIGS.map((f) => [f, renderDeploy(readFileSync(f, 'utf8'), values)])
	);
	const problems =
		missing.length > 0 ? missing : deployProblems(rendered, gitStatus(), readVersions());
	if (problems.length > 0) {
		console.error('deploy: refusing to run.\n' + problems.map((p) => `  - ${p}`).join('\n'));
		console.error('See docs/RUNBOOK.md and .deploy.env.example.');
		return 1;
	}
	if (argv.includes('--write-config')) {
		for (const [f, text] of Object.entries(rendered)) writeFileSync(generatedPath(f), text);
		console.log(`deploy: wrote ${GENERATED.join(', ')} (real ids; gitignored, delete when done).`);
		return 0;
	}
	// The account id also goes to wrangler through the environment, so no call can pick another account.
	process.env.CLOUDFLARE_ACCOUNT_ID = values.CLOUDFLARE_ACCOUNT_ID;
	cleanUpOnSignals(process, GENERATED, () => child);
	removeGenerated();
	let status: number;
	try {
		for (const [f, text] of Object.entries(rendered)) writeFileSync(generatedPath(f), text);
		status = await runSteps(buildSteps(dryRun));
	} finally {
		removeGenerated();
	}
	if (status === 0)
		console.log(dryRun ? '\ndeploy: dry run finished; nothing was uploaded.' : '\ndeploy: done.');
	return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	process.exit(await main(process.argv.slice(2)));
