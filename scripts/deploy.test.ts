import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	buildSteps,
	CONFIGS,
	deployProblems,
	generatedPath,
	parseBookmark,
	parseEnvFile,
	removeGenerated,
	renderDeploy,
	resolveDeployValues,
	runSteps,
	cleanUpOnSignals,
	type DeployValues,
	type Step
} from './deploy';

const ACCOUNT = '1234567890abcdef1234567890abcdef';
const D1 = '1b2c3d4e-0f1a-4b2c-8d3e-0123456789ab';
const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ENV = {
	CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
	RUBY_D1_DATABASE_ID: D1,
	RUBY_APP_HOST: 'ruby.team-site.dev',
	RUBY_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com',
	RUBY_ACCESS_AUD: AUD
};
const committed = readFileSync(CONFIGS[0], 'utf8');
const withoutAccessPair = () => {
	const env: Record<string, string> = { ...ENV };
	delete env.RUBY_ACCESS_TEAM_DOMAIN;
	delete env.RUBY_ACCESS_AUD;
	return env;
};
const resolved = (env: Record<string, string> = ENV) => resolveDeployValues(env, {});
const render = (env?: Record<string, string>) =>
	renderDeploy(committed, resolved(env).values as DeployValues);

describe('committed wrangler.jsonc', () => {
	it('holds only placeholders, and Access required by default', () => {
		expect(committed).toContain('"account_id": "00000000000000000000000000000000"');
		expect(committed).toContain('"database_id": "00000000-0000-4000-8000-000000000000"');
		expect(committed).toContain('ruby.example.invalid');
		expect(committed).toContain('"ACCESS_DISABLED": ""');
		expect(committed).not.toMatch(/macan\.|cloudflareaccess\.com"/);
	});
});

describe('resolveDeployValues', () => {
	it('accepts a complete, well-formed set', () => {
		expect(resolved().problems).toEqual([]);
	});
	it('names missing variables, never values', () => {
		const { problems } = resolved({});
		expect(problems.join()).toMatch(/CLOUDFLARE_ACCOUNT_ID is not set/);
		expect(problems.join()).toMatch(/RUBY_ACCESS_AUD is not set/);
	});
	it('rejects wrong shapes, zero ids and placeholder hosts without echoing them', () => {
		const bad = {
			...ENV,
			CLOUDFLARE_ACCOUNT_ID: 'x'.repeat(40),
			RUBY_D1_DATABASE_ID: '00000000-0000-4000-8000-000000000000',
			RUBY_APP_HOST: 'ruby.example.invalid'
		};
		const { problems } = resolved(bad);
		expect(problems).toHaveLength(3);
		expect(problems.join()).not.toContain('xxxx');
	});
	it('does not need the Access pair when Access is disabled', () => {
		const rest = withoutAccessPair();
		expect(resolved({ ...rest, RUBY_ACCESS_DISABLED: '1' }).problems).toEqual([]);
		expect(resolved({ ...rest, RUBY_ACCESS_DISABLED: 'yes' }).problems).toEqual([
			'RUBY_ACCESS_TEAM_DOMAIN is not set (environment or .deploy.env)',
			'RUBY_ACCESS_AUD is not set (environment or .deploy.env)',
			'RUBY_ACCESS_DISABLED must be empty or 1'
		]);
	});
	it('prefers the environment over the file', () => {
		const out = resolveDeployValues(
			{ RUBY_APP_HOST: 'a.team-site.dev' },
			{ ...ENV, RUBY_APP_HOST: 'b.team-site.dev' }
		);
		expect(out.values.RUBY_APP_HOST).toBe('a.team-site.dev');
	});
});

describe('parseEnvFile', () => {
	it('reads pairs, skips comments, drops quotes and export', () => {
		expect(parseEnvFile('# c\n\nA=1\nexport B="two"\nC = \'3\'\nbad\n')).toEqual({
			A: '1',
			B: 'two',
			C: '3'
		});
	});
});

describe('renderDeploy and deployProblems', () => {
	it('replaces every placeholder, leaving the rest alone', () => {
		const out = render();
		for (const v of [ACCOUNT, D1, 'ruby.team-site.dev', 'myteam.cloudflareaccess.com', AUD])
			expect(out).toContain(v);
		expect(out).toContain('"ACCESS_DISABLED": ""');
		expect(out).not.toMatch(/example\.invalid|0{32}/);
		expect(deployProblems({ [CONFIGS[0]]: out }, '')).toEqual([]);
	});
	it('renders ACCESS_DISABLED=1 with empty Access settings', () => {
		const rest = withoutAccessPair();
		const out = render({ ...rest, RUBY_ACCESS_DISABLED: '1' });
		expect(out).toContain('"ACCESS_DISABLED": "1"');
		expect(out).toContain('"ACCESS_TEAM_DOMAIN": ""');
		expect(deployProblems({ [CONFIGS[0]]: out }, '')).toEqual([]);
	});
	it('refuses the unrendered committed config, naming placeholders only', () => {
		const problems = deployProblems({ [CONFIGS[0]]: committed }, '');
		expect(problems.join('\n')).toMatch(/placeholder account_id/);
		expect(problems.join('\n')).toMatch(/placeholder D1 database_id/);
		expect(problems.join('\n')).toMatch(/placeholder host/);
		expect(problems.join('\n')).toMatch(/placeholder ACCESS_AUD/);
	});
	it('refuses a dirty tree, and a failed git status', () => {
		const ok = { [CONFIGS[0]]: render() };
		expect(deployProblems(ok, ' M src/app.css\n')).toEqual([expect.stringMatching(/not clean/)]);
		expect(deployProblems(ok, null)).toEqual([expect.stringMatching(/git status failed/)]);
	});
	it('refuses a config without a D1 id', () => {
		expect(deployProblems({ [CONFIGS[0]]: '{}' }, '')).toEqual([
			expect.stringMatching(/no D1 database_id/)
		]);
	});
});

describe('deployProblems: versions', () => {
	const config = (v: string) => render().replace(/"APP_VERSION": "[^"]*"/, `"APP_VERSION": "${v}"`);
	it('allows package.json, APP_VERSION and the newest release notes in agreement', () => {
		expect(
			deployProblems({ [CONFIGS[0]]: config('0.2.0') }, '', {
				packageVersion: '0.2.0',
				latestRelease: '0.2.0'
			})
		).toEqual([]);
	});
	it('refuses when they disagree', () => {
		expect(
			deployProblems({ [CONFIGS[0]]: config('0.1.0') }, '', {
				packageVersion: '0.2.0',
				latestRelease: '0.2.0'
			})
		).toEqual([expect.stringMatching(/APP_VERSION 0\.1\.0 differs/)]);
		expect(
			deployProblems({ [CONFIGS[0]]: config('0.2.0') }, '', {
				packageVersion: '0.2.0',
				latestRelease: '0.1.0'
			})
		).toEqual([expect.stringMatching(/newest release notes 0\.1\.0/)]);
	});
});

describe('buildSteps', () => {
	const gen = generatedPath(CONFIGS[0]);
	it('bookmark, remote migrations, build, deploy, all on the generated config', () => {
		const steps = buildSteps(false);
		expect(steps.map((s) => s.args.slice(0, 4).join(' '))).toEqual([
			'wrangler d1 time-travel info',
			'wrangler d1 migrations apply',
			'vite build',
			'wrangler deploy -c wrangler.deploy.generated.jsonc'
		]);
		expect(steps[1]?.args).toContain('--remote');
		for (const i of [0, 1, 3]) expect(steps[i]?.args).toContain(gen);
		expect(steps[3]?.args).not.toContain('--dry-run');
		expect(steps.some((s) => s.args.includes('wrangler.jsonc'))).toBe(false);
	});
	it('--dry-run skips everything remote and passes --dry-run to wrangler deploy', () => {
		const steps = buildSteps(true);
		expect(steps.map((s) => s.label)).toEqual(['Build', 'Deploy Worker']);
		expect(steps[1]?.args).toEqual(['wrangler', 'deploy', '-c', gen, '--dry-run']);
	});
});

describe('generated file cleanup', () => {
	it('is gitignored', () => {
		expect(readFileSync('.gitignore', 'utf8')).toMatch(/^wrangler\.\*\.generated\.jsonc$/m);
		expect(readFileSync('.gitignore', 'utf8')).toMatch(/^\.deploy\.env$/m);
	});
	it('removeGenerated tolerates missing files', () => {
		expect(() => removeGenerated(['nope.generated.jsonc'])).not.toThrow();
	});
	it('SIGINT/SIGTERM handlers kill the child, remove files and exit 130/143', () => {
		const handlers: Record<string, () => void> = {};
		const exit = vi.fn();
		const kill = vi.fn();
		cleanUpOnSignals(
			{ on: (s, h) => (handlers[s] = h), exit },
			['nope.generated.jsonc'],
			() => ({ kill }) as never
		);
		handlers.SIGINT?.();
		handlers.SIGTERM?.();
		expect(kill).toHaveBeenCalledWith('SIGINT');
		expect(exit.mock.calls).toEqual([[130], [143]]);
	});
});

describe('parseBookmark', () => {
	it('reads JSON and text output', () => {
		expect(
			parseBookmark('{"bookmark": "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683"}')
		).toBe('00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683');
		expect(
			parseBookmark(
				'🚧 Time Traveling... bookmark: 00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683'
			)
		).toBe('00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683');
		expect(parseBookmark('no bookmark here')).toBeNull();
	});
});

describe('runSteps', () => {
	const quiet = () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	};

	it('stops at the first failing step', async () => {
		quiet();
		const ran: string[] = [];
		const code = await runSteps(buildSteps(false), async (step: Step) => {
			ran.push(step.label);
			return step.bookmark
				? { code: 0, out: '{"bookmark":"00000001-00000002-00000003-abc"}' }
				: { code: step.label === 'Apply remote migrations' ? 1 : 0, out: '' };
		});
		expect(code).toBe(1);
		expect(ran).toEqual(['D1 Time Travel bookmark (rollback point)', 'Apply remote migrations']);
		vi.restoreAllMocks();
	});

	it('never migrates without a bookmark', async () => {
		quiet();
		const ran: string[] = [];
		const code = await runSteps(buildSteps(false), async (step: Step) => {
			ran.push(step.label);
			return { code: 0, out: '' };
		});
		expect(code).toBe(1);
		expect(ran).toEqual(['D1 Time Travel bookmark (rollback point)']);
		vi.restoreAllMocks();
	});
});
