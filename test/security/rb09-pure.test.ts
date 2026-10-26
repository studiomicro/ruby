import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	buildSteps,
	CONFIGS,
	deployProblems,
	renderDeploy,
	resolveDeployValues,
	runSteps,
	type DeployValues
} from '../../scripts/deploy';
import { parseEventForm } from '#lib/server/events/validation';
import { emailText } from '#lib/server/reminders/dispatch';
import { emailSender } from '#lib/server/reminders/jobs';
import { eventSummary, personalSummary, taskSummary } from '#lib/server/reminders/summary';
import {
	CAL_LIMITS,
	daysBetween,
	expandEvent,
	parseCalendarFilter,
	REMINDER_LIMITS,
	viewRanges,
	zonedToUtc
} from '#lib/shared/calendar';

/**
 * RB-09 red team, pure probes (docs/features/rb-09-calendar-reminders/SECURITY_REPORT.md): the deploy script's two
 * rendered configs, the reminder e-mail and summary builders, the event form's recurrence and date limits and the
 * calendar URL parser. Every test asserts a defence that holds. Fictional values only.
 */

const JKT = 'Asia/Jakarta';

// ── Deploy script ────────────────────────────────────────────────────────────────────────────────────────────

const ACCOUNT = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const D1 = '7a7a7a7a-1b1b-4c2c-8d3d-4e4e4e4e4e4e';
const OTHER_D1 = '9f9f9f9f-1b1b-4c2c-8d3d-4e4e4e4e4e4e';
const AUD = 'beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef';
const ENV = {
	CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
	RUBY_D1_DATABASE_ID: D1,
	RUBY_APP_HOST: 'ruby.fictional-team.dev',
	RUBY_ACCESS_TEAM_DOMAIN: 'fictional.cloudflareaccess.com',
	RUBY_ACCESS_AUD: AUD,
	RUBY_REMINDER_EMAIL_FROM: 'ruby@fictional-team.dev'
};
const committed = Object.fromEntries(CONFIGS.map((f) => [f, readFileSync(f, 'utf8')]));
const renderAll = (env: Record<string, string> = ENV) => {
	const { values } = resolveDeployValues(env, {});
	return Object.fromEntries(
		CONFIGS.map((f) => [f, renderDeploy(committed[f] as string, values as DeployValues)])
	);
};
const VALUE_STRINGS = [ACCOUNT, D1, OTHER_D1, AUD, 'fictional-team', 'fictional.cloudflareaccess'];
const noValues = (lines: string[]) => {
	const text = lines.join('\n');
	for (const v of VALUE_STRINGS) expect(text).not.toContain(v);
};

describe('deploy script: two configs from .deploy.env', () => {
	it('renders both configs with the same D1 id and no placeholder left; clean tree passes', () => {
		const rendered = renderAll();
		for (const f of CONFIGS) {
			expect(rendered[f]).toContain(`"database_id": "${D1}"`);
			expect(rendered[f]).not.toMatch(/example\.invalid|0{8}-0{4}-4000-8000-0{12}|"0{32}"/);
		}
		expect(rendered[CONFIGS[1]]).toContain('"REMINDER_EMAIL_FROM": "ruby@fictional-team.dev"');
		expect(rendered[CONFIGS[1]]).toContain('"APP_HOST": "ruby.fictional-team.dev"');
		expect(deployProblems(rendered, '')).toEqual([]);
	});

	it('refuses a jobs config that binds another database, naming files only, never ids', () => {
		const rendered = renderAll();
		rendered[CONFIGS[1]] = (rendered[CONFIGS[1]] as string).replace(D1, OTHER_D1);
		const problems = deployProblems(rendered, '');
		expect(problems.some((p) => /database_id differs/.test(p))).toBe(true);
		noValues(problems);
	});

	it('refuses an unrendered jobs config (placeholders) and a jobs config with its D1 binding removed', () => {
		const rendered = renderAll();
		const placeholders = deployProblems(
			{ ...rendered, [CONFIGS[1]]: committed[CONFIGS[1]] as string },
			''
		);
		expect(placeholders.filter((p) => p.startsWith(CONFIGS[1])).length).toBeGreaterThanOrEqual(3);
		const noD1 = (rendered[CONFIGS[1]] as string).replace(/"database_id"[^\n]*/, '');
		expect(deployProblems({ ...rendered, [CONFIGS[1]]: noD1 }, '')).toContain(
			`${CONFIGS[1]}: no D1 database_id`
		);
	});

	it('refuses a sender that would break out of the JSON string or a placeholder value; problems never echo it', () => {
		for (const bad of [
			'ruby@x.dev", "ACCESS_DISABLED": "1',
			'ruby\\@x.dev',
			'ruby@x.dev\nEVIL=1',
			'ruby @x.dev',
			'ruby@ruby.example.invalid',
			'not-an-address'
		]) {
			const { problems } = resolveDeployValues({ ...ENV, RUBY_REMINDER_EMAIL_FROM: bad }, {});
			expect(problems, bad).toEqual(['RUBY_REMINDER_EMAIL_FROM does not have the expected form']);
			expect(problems.join('')).not.toContain(bad);
		}
		// Empty: e-mail stays off and nothing is refused.
		const { problems, values } = resolveDeployValues({ ...ENV, RUBY_REMINDER_EMAIL_FROM: '' }, {});
		expect(problems).toEqual([]);
		expect(renderDeploy(committed[CONFIGS[1]] as string, values as DeployValues)).toContain(
			'"REMINDER_EMAIL_FROM": ""'
		);
	});

	it('wrong-shaped values are named, never printed', () => {
		const { problems } = resolveDeployValues(
			{
				...ENV,
				CLOUDFLARE_ACCOUNT_ID: `${ACCOUNT}x`,
				RUBY_D1_DATABASE_ID: `${D1}"`,
				RUBY_APP_HOST: 'fictional-team/../x'
			},
			{}
		);
		expect(problems.length).toBe(3);
		noValues(problems);
	});

	it('runs the jobs Worker before the app; dry run touches nothing remote; the log carries paths, not values', async () => {
		const live = buildSteps(false).map((s) => s.label);
		expect(live.indexOf('Deploy jobs Worker (ruby-jobs)')).toBeLessThan(
			live.indexOf('Deploy app Worker')
		);
		expect(live.indexOf('Apply remote migrations')).toBeLessThan(
			live.indexOf('Deploy jobs Worker (ruby-jobs)')
		);
		const dry = buildSteps(true);
		expect(dry.some((s) => s.args.includes('--remote') || s.bookmark)).toBe(false);
		expect(
			dry.filter((s) => s.args.includes('deploy')).every((s) => s.args.includes('--dry-run'))
		).toBe(true);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await runSteps(dry, async () => ({ code: 0, out: '' }));
		const lines = log.mock.calls.map((c) => c.join(' '));
		log.mockRestore();
		expect(lines.join('\n')).toContain('workers/jobs/wrangler.deploy.generated.jsonc');
		noValues(lines);
	});

	it('the jobs Worker config: cron, no route, no workers.dev, no assets, no R2, invocation logs off', () => {
		const jobs = committed[CONFIGS[1]] as string;
		expect(jobs).toMatch(/"crons":\s*\["\* \* \* \* \*"\]/);
		expect(jobs).toMatch(/"workers_dev":\s*false/);
		expect(jobs).not.toMatch(/"routes?"\s*:|"assets"\s*:|"r2_buckets"\s*:|"migrations_dir"/);
		expect(jobs).toMatch(/"invocation_logs":\s*false/);
	});
});

// ── Reminder e-mail and summaries ────────────────────────────────────────────────────────────────────────────

const CRLF_TITLE = 'Fix login\r\nBcc: victim@fictional.test\r\n\r\n<b>Click</b>';

describe('reminder e-mail: header and content injection', () => {
	it('summaries are one line: CR, LF, U+2028/2029, NEL, bidi and zero-width are gone; at most 140 characters', () => {
		const now = zonedToUtc('2026-11-04', '09:00', JKT);
		const lines = [
			taskSummary({ ref: 'OPS-1', title: CRLF_TITLE, dueOn: '2026-11-05' }, now, JKT),
			eventSummary(
				{ title: `Sync\u2028Bcc: x@y.test\u2029\u0085\u202Egnp.exe\u200B`, allDay: false },
				{ onDate: '2026-11-04', startAt: now + 3_600_000 },
				now,
				JKT
			),
			personalSummary(`${'A'.repeat(300)}\r\nBcc: z@y.test`),
			taskSummary({ ref: 'OPS-2', title: 'x'.repeat(500), dueOn: '2026-11-05' }, now, JKT)
		];
		for (const s of lines) {
			expect(s).not.toMatch(/[\r\n\u2028\u2029\u0085\u202E\u200B]/);
			expect(Array.from(s).length).toBeLessThanOrEqual(REMINDER_LIMITS.summaryMax);
		}
		expect(lines[3]).toMatch(/is due tomorrow$/);
		expect(personalSummary('\r\n\u200B')).toBe('Reminder');
	});

	it('the body is plain text; links come only from the configured APP_HOST', () => {
		const text = emailText('<b>OPS-1</b> Fix', 'https://ruby.fictional-team.dev');
		expect(text).toContain('<b>OPS-1</b> Fix'); // literal text in a text/plain body: never interpreted
		expect(text.match(/https:\/\/[^\s]+/g)).toEqual([
			'https://ruby.fictional-team.dev/notifications',
			'https://ruby.fictional-team.dev/account'
		]);
		expect(emailText('x', null)).not.toMatch(/https?:/);
	});

	it('emailSender: off without a sender or binding; a malformed or placeholder APP_HOST gives no links', () => {
		const binding = { send: async () => undefined };
		const db = {} as D1Database;
		expect(emailSender({ DB: db, REMINDER_EMAIL_FROM: '', EMAIL: binding })).toBeNull();
		expect(emailSender({ DB: db, REMINDER_EMAIL_FROM: '  ', EMAIL: binding })).toBeNull();
		expect(emailSender({ DB: db, REMINDER_EMAIL_FROM: 'r@x.dev' })).toBeNull();
		for (const host of [
			'evil.test/phish?x=',
			'evil.test:8443',
			'user@evil.test',
			'ruby.example.invalid',
			'javascript:alert(1)//x.com',
			'',
			'localhost'
		])
			expect(
				emailSender({ DB: db, REMINDER_EMAIL_FROM: 'r@x.dev', APP_HOST: host, EMAIL: binding })
					?.origin,
				host
			).toBeNull();
		expect(
			emailSender({
				DB: db,
				REMINDER_EMAIL_FROM: 'r@x.dev',
				APP_HOST: ' Ruby.Team.DEV ',
				EMAIL: binding
			})?.origin
		).toBe('https://ruby.team.dev');
	});
});

// ── Event form: recurrence explosion, dates, times ───────────────────────────────────────────────────────────

const form = (fields: Record<string, string | string[]>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields))
		for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
	return f;
};
const base = {
	title: 'Fictional sync',
	startDate: '2026-11-02',
	startTime: '14:00',
	endDate: '2026-11-02',
	endTime: '15:00'
};
const parse = (extra: Record<string, string | string[]>) =>
	parseEventForm(form({ ...base, ...extra }), JKT);

describe('event form limits (server side)', () => {
	it('a series must end within 2 years and 500 occurrences; intervals 1..30; no unknown frequency', () => {
		const refused: Record<string, string>[] = [
			{ repeat: 'daily', ends: 'count', count: '501' },
			{ repeat: 'daily', ends: 'count', count: '0' },
			{ repeat: 'daily', ends: 'count', count: '1e2' },
			{ repeat: 'daily', ends: 'count', count: '-5' },
			{ repeat: 'daily', ends: 'until', until: '2028-11-03' },
			{ repeat: 'daily', ends: 'until', until: '2028-03-20' }, // < 2 years but > 500 days
			{ repeat: 'weekly', ends: 'until', until: '2028-11-09' },
			{ repeat: 'monthly', interval: '30', ends: 'count', count: '2' }, // 2nd occurrence 30 months out
			{ repeat: 'daily', ends: '' },
			{ repeat: 'daily', ends: 'never' },
			{ repeat: 'daily', interval: '0', ends: 'count', count: '2' },
			{ repeat: 'daily', interval: '31', ends: 'count', count: '2' },
			{ repeat: 'daily', interval: '1.5', ends: 'count', count: '2' },
			{ repeat: 'daily', interval: ' 2', ends: 'count', count: '2' },
			{ repeat: 'yearly', ends: 'count', count: '2' },
			{ repeat: 'daily', ends: 'until', until: '2026-11-01' }
		];
		for (const r of refused) expect(parse(r).ok, JSON.stringify(r)).toBe(false);
		const ok = parse({ repeat: 'daily', ends: 'count', count: '500' });
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(daysBetween(ok.value.firstOn, ok.value.lastOn)).toBe(499);
		expect(parse({ repeat: 'monthly', ends: 'until', until: '2028-11-02' }).ok).toBe(true);
	});

	it('dates stay in 2000..2100 (also the series end); times are 5-minute HH:MM; durations capped', () => {
		const refused: Record<string, string>[] = [
			{ startDate: '1999-12-31', endDate: '1999-12-31' },
			{ startDate: '2101-01-01', endDate: '2101-01-01' },
			{ startDate: '2026-02-29', endDate: '2026-02-29' },
			{ startDate: '2026-11-2', endDate: '2026-11-2' },
			{
				startDate: '2100-12-31',
				endDate: '2100-12-31',
				endTime: '23:55',
				repeat: 'daily',
				ends: 'count',
				count: '2'
			},
			{ startTime: '14:03' },
			{ startTime: '24:00' },
			{ startTime: '9:00' },
			{ endTime: '13:55' },
			{ endTime: '14:00' },
			{ endDate: '2026-11-16', endTime: '14:05' }, // 14 days + 5 minutes
			{ allDay: 'on', endDate: '2026-12-03' }, // 32 days
			{ title: '\u200B\r\n\u202E ' },
			{ title: 'x'.repeat(121) },
			{ location: 'y'.repeat(201) },
			{ description: 'z'.repeat(5001) },
			{ visibility: 'public' },
			{ projectId: "x' OR 1=1 --" }
		];
		for (const r of refused) expect(parse(r).ok, JSON.stringify(r)).toBe(false);
		expect(parse({ endDate: '2026-11-16', endTime: '14:00' }).ok).toBe(true);
	});

	it('attendees: at most 50 distinct UUIDs (case folded); junk ids refused', () => {
		const ids = Array.from({ length: 51 }, () => crypto.randomUUID());
		expect(parse({ attendees: ids }).ok).toBe(false);
		const fifty = ids.slice(0, 50);
		const dup = parse({ attendees: [...fifty, ...fifty.map((i) => i.toUpperCase())] });
		// 100 posted values are cut to 51 before the dedupe, which keeps 50 distinct: accepted, nothing extra.
		expect(dup.ok).toBe(true);
		if (dup.ok) expect(dup.value.attendeeIds).toHaveLength(50);
		expect(parse({ attendees: ['not-a-uuid'] }).ok).toBe(false);
		expect(parse({ attendees: ["'); DROP TABLE events; --"] }).ok).toBe(false);
	});

	it('title and location are single-line plain text: control, bidi and zero-width removed', () => {
		const r = parse({
			title: 'Sync\r\nBcc: x@y.test\u202E\u200B',
			location: 'Room\u0000 1\n<script>alert(1)</script>'
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.title).toBe('Sync Bcc: x@y.test');
		expect(r.value.location).toBe('Room 1 <script>alert(1)</script>'); // stored as text, rendered escaped
	});
});

describe('expansion and window bounds', () => {
	it('a 500-occurrence daily series expands to at most 500 instances, only inside the window', () => {
		const r = parse({ repeat: 'daily', ends: 'count', count: '500' });
		if (!r.ok) throw new Error('setup');
		const all = expandEvent(r.value, '2000-01-01', '2100-12-31', new Set(), JKT);
		expect(all.length).toBe(500);
		const window = expandEvent(r.value, '2027-01-01', '2027-01-31', new Set(), JKT);
		expect(window.length).toBe(31);
		expect(window.every((o) => o.onDate >= '2027-01-01' && o.onDate <= '2027-01-31')).toBe(true);
		expect(expandEvent(r.value, '2000-01-01', '2100-12-31', new Set(), JKT, 7)).toHaveLength(7);
	});

	it('URL dates are clamped to 2000..2100 and one read is at most 62 days, whatever the view', () => {
		for (const raw of ['0000-01-01', '9999-12-31', '2026-13-45', '2026-11-02T00:00', "' OR 1=1"]) {
			const f = parseCalendarFilter(
				new URLSearchParams({ date: raw, view: 'month' }),
				'2026-11-02',
				['tasks', 'events']
			);
			expect(f.date >= CAL_LIMITS.dateMin && f.date <= CAL_LIMITS.dateMax, raw).toBe(true);
			for (const view of ['month', 'week', 'agenda', null] as const) {
				const { window } = viewRanges(view, f.date);
				expect(daysBetween(window.from, window.to) + 1).toBeLessThanOrEqual(
					CAL_LIMITS.windowMaxDays
				);
			}
		}
		const f = parseCalendarFilter(
			new URLSearchParams('show=tasks,events,timeoff,__proto__&project=OPS;--&tasks=project'),
			'2026-11-02',
			['tasks', 'events']
		);
		expect(f.show).toEqual(['tasks', 'events']);
		expect(f.project).toBeNull();
		expect(f.tasks).toBe('mine');
	});
});
