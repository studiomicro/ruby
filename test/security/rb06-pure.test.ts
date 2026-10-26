import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CLIENT_MAX_ATTEMPTS,
	THROTTLE_MAX_ATTEMPTS,
	THROTTLE_MINUTE_MS,
	THROTTLE_SCOPES,
	THROTTLE_WINDOW_MS
} from '#lib/server/auth/throttle';
import { isCrossSiteForm } from '#lib/server/csrf';
import type { Viewer } from '#lib/server/hr/visibility';
import { annualEntitlement } from '#lib/server/timeoff/accrual';
import { addDays, countHalfDays, isoWeekday } from '#lib/server/timeoff/calendar';
import {
	approverFor,
	canCancel,
	canDecide,
	type DecideContext
} from '#lib/server/timeoff/permissions';
import {
	LEAVE_LIMITS,
	LEAVE_MESSAGES,
	parseAdjustment,
	parseHalfDays,
	parseRequest,
	parseWorkDays,
	type LeaveTypeInfo
} from '#lib/server/timeoff/validation';

/**
 * RB-06 red team, cycle 1: pure probes of the approval matrix, the date arithmetic, the request parser, the throttle
 * merge and static scans of the new trees. Findings: docs/features/rb-06-time-off/SECURITY_REPORT.md. "PROOF" tests
 * pin a finding's current behaviour; the others prove a control that held.
 */

const viewer = (userId: string, flags: Partial<Viewer> = {}): Viewer => ({
	userId,
	isHr: false,
	isAdmin: false,
	ownEmployeeId: null,
	...flags
});

describe('approval matrix (canDecide / approverFor)', () => {
	const report: DecideContext = {
		requesterUserId: 'u-report',
		employeeUserId: 'u-report',
		managerUserId: 'u-manager',
		otherHrExists: true
	};

	it('only the direct manager or HR decides; requester, peer, skip-level and a plain admin never do', () => {
		expect(canDecide(viewer('u-manager'), report)).toBe(true);
		expect(canDecide(viewer('u-hr', { isHr: true }), report)).toBe(true);
		expect(canDecide(viewer('u-report'), report)).toBe(false);
		expect(canDecide(viewer('u-report', { isHr: true, isAdmin: true }), report)).toBe(false);
		expect(canDecide(viewer('u-peer'), report)).toBe(false);
		expect(canDecide(viewer('u-top'), report)).toBe(false);
		expect(canDecide(viewer('u-admin', { isAdmin: true }), report)).toBe(false);
	});

	it('the currently linked account is refused too, even when someone else submitted (relinked record)', () => {
		const relinked = { ...report, requesterUserId: 'u-old', employeeUserId: 'u-new' };
		expect(canDecide(viewer('u-new', { isHr: true }), relinked)).toBe(false);
		expect(canDecide(viewer('u-old', { isHr: true }), relinked)).toBe(false);
	});

	it('fallback: no manager account → HR; no other HR → admin; a plain admin never jumps the queue', () => {
		const noManager = { ...report, managerUserId: null };
		expect(approverFor(noManager)).toBe('hr');
		expect(canDecide(viewer('u-admin', { isAdmin: true }), noManager)).toBe(false);
		const noOtherHr = { ...noManager, otherHrExists: false };
		expect(approverFor(noOtherHr)).toBe('admin');
		expect(canDecide(viewer('u-admin', { isAdmin: true }), noOtherHr)).toBe(true);
		expect(canDecide(viewer('u-member'), noOtherHr)).toBe(false);
	});

	it('FIXED L1 (owner decision 10 addendum): the sole HR + sole admin owner self-approves, nobody else', () => {
		const owner: DecideContext = {
			requesterUserId: 'u-owner',
			employeeUserId: 'u-owner',
			managerUserId: null,
			otherHrExists: false,
			otherAdminExists: false
		};
		expect(approverFor(owner)).toBe('self');
		expect(canDecide(viewer('u-owner', { isHr: true, isAdmin: true }), owner)).toBe(true);
		for (const other of [viewer('u-member'), viewer('u-manager')])
			expect(canDecide(other, owner)).toBe(false);
		// It switches off once a second HR user or a manager account exists.
		expect(
			canDecide(viewer('u-owner', { isHr: true, isAdmin: true }), { ...owner, otherHrExists: true })
		).toBe(false);
		expect(
			canDecide(viewer('u-owner', { isHr: true, isAdmin: true }), {
				...owner,
				managerUserId: 'u-boss'
			})
		).toBe(false);
	});
});

describe('cancel rights (canCancel)', () => {
	const today = '2026-10-26';
	const mine = (status: 'pending' | 'approved' | 'rejected' | 'canceled', startOn: string) => ({
		status,
		startOn,
		employeeId: 'e-me'
	});

	it('requester: pending any time, approved only before the start; never rejected or canceled', () => {
		const me = viewer('u-me', { ownEmployeeId: 'e-me' });
		expect(canCancel(me, mine('pending', '2026-10-01'), today)).toBe('self');
		expect(canCancel(me, mine('approved', '2026-10-27'), today)).toBe('self');
		expect(canCancel(me, mine('approved', today), today)).toBeNull();
		expect(canCancel(me, mine('rejected', '2026-11-01'), today)).toBeNull();
		expect(canCancel(me, mine('canceled', '2026-11-01'), today)).toBeNull();
		expect(canCancel(viewer('u-other'), mine('pending', '2026-11-01'), today)).toBeNull();
	});

	it('FIXED L2 (owner: allowed, audited as self): HR may override-cancel their own started leave', () => {
		const hrMe = viewer('u-me', { isHr: true, ownEmployeeId: 'e-me' });
		expect(canCancel(hrMe, mine('approved', '2026-10-20'), today)).toBe('override');
	});

	it('FIXED L3: ownership follows the record’s current link, not who submitted it', () => {
		const formerAccount = viewer('u-me', { ownEmployeeId: null });
		expect(canCancel(formerAccount, mine('pending', '2026-11-01'), today)).toBeNull();
		const successor = viewer('u-new', { ownEmployeeId: 'e-me' });
		expect(canCancel(successor, mine('pending', '2026-11-01'), today)).toBe('self');
	});
});

describe('day counting (countHalfDays)', () => {
	const week = [1, 2, 3, 4, 5];
	const count = (
		startOn: string,
		endOn: string,
		extra: Partial<Parameters<typeof countHalfDays>[0]> = {}
	) => countHalfDays({ startOn, endOn, halfDay: 'none', workDays: week, holidays: [], ...extra });

	it('leap day 2028 counts, a non-leap February does not invent one', () => {
		expect(isoWeekday('2028-02-28')).toBe(1);
		expect(count('2028-02-28', '2028-03-01').halfDays).toBe(6);
		expect(isoWeekday('2027-02-26')).toBe(5);
		expect(count('2027-02-26', '2027-03-01')).toEqual({
			halfDays: 4,
			skipped: { weekends: 2, holidays: 0 }
		});
	});

	it('across New Year (logged types) and over a weekend', () => {
		expect(isoWeekday('2026-12-31')).toBe(4);
		expect(count('2026-12-31', '2027-01-04').halfDays).toBe(6);
	});

	it('holidays: non-deducting skipped, deducting counted, a holiday on a weekend is a weekend', () => {
		const holidays = [
			{ onDate: '2026-12-25', deductsLeave: false },
			{ onDate: '2026-12-24', deductsLeave: true },
			{ onDate: '2026-12-26', deductsLeave: false }
		];
		expect(count('2026-12-21', '2026-12-27', { holidays })).toEqual({
			halfDays: 8,
			skipped: { weekends: 2, holidays: 1 }
		});
	});

	it('half days: one only on a single work date; zero on a weekend or a skipped holiday', () => {
		expect(count('2026-10-26', '2026-10-26', { halfDay: 'am' }).halfDays).toBe(1);
		expect(count('2026-10-31', '2026-10-31', { halfDay: 'pm' }).halfDays).toBe(0);
		expect(
			count('2026-12-25', '2026-12-25', {
				halfDay: 'am',
				holidays: [{ onDate: '2026-12-25', deductsLeave: false }]
			}).halfDays
		).toBe(0);
		expect(
			count('2026-12-24', '2026-12-24', {
				halfDay: 'am',
				holidays: [{ onDate: '2026-12-24', deductsLeave: true }]
			}).halfDays
		).toBe(1);
		// A multi-day range ignores a smuggled half-day part (the parser refuses it anyway).
		expect(count('2026-10-26', '2026-10-27', { halfDay: 'am' }).halfDays).toBe(4);
	});

	it('a 6-day week counts Saturday; the longest allowed range stays cheap', () => {
		expect(count('2026-10-26', '2026-11-01', { workDays: [1, 2, 3, 4, 5, 6] }).halfDays).toBe(12);
		const started = performance.now();
		expect(count('2026-01-01', '2027-01-01').halfDays).toBeGreaterThan(0);
		expect(performance.now() - started).toBeLessThan(100);
	});
});

describe('proration (annualEntitlement)', () => {
	const e = (startOn: string | null, period: number, annualHalfDays = 24) =>
		annualEntitlement({ startOn, period, annualHalfDays });

	it('1 day per full month in the start year, the 1st counting its month, full later, none before', () => {
		expect(e('2026-01-01', 2026)).toBe(24);
		expect(e('2026-01-02', 2026)).toBe(22);
		expect(e('2026-03-01', 2026)).toBe(20);
		expect(e('2026-03-15', 2026)).toBe(18);
		expect(e('2026-12-01', 2026)).toBe(2);
		expect(e('2026-12-31', 2026)).toBe(0);
		expect(e('2028-02-29', 2028)).toBe(20);
		expect(e('2026-03-15', 2027)).toBe(24);
		expect(e('2026-03-15', 2025)).toBe(0);
		expect(e(null, 2026)).toBe(0);
		// Odd yearly amounts round down to whole half-days, never up.
		expect(e('2026-03-15', 2026, 25)).toBe(18);
	});
});

describe('request parser (dates, spans, half days, reasons)', () => {
	const types: LeaveTypeInfo[] = [
		{ id: 'lt_annual', kind: 'balance', requiresReason: false, active: true },
		{ id: 'lt_sick', kind: 'logged', requiresReason: false, active: true },
		{ id: 'lt_special', kind: 'logged', requiresReason: true, active: true },
		{ id: 'lt_old', kind: 'logged', requiresReason: false, active: false }
	];
	const today = '2026-10-26';
	const form = (fields: Record<string, string>) => {
		const f = new FormData();
		for (const [k, v] of Object.entries(fields)) f.set(k, v);
		return f;
	};
	const parse = (fields: Record<string, string>) =>
		parseRequest(form({ typeId: 'lt_sick', ...fields }), types, today);

	it.each([
		'2026-02-30',
		'2027-02-29',
		'2026-13-01',
		'2026-00-10',
		'2026-1-05',
		'２０２６-11-02',
		'2026-11-02T00:00',
		'+2026-11-02',
		'99999-11-02',
		'0000-01-01',
		'2026-11-02\u0000',
		''
	])('refuses the malformed date %j', (startOn) => {
		const r = parse({ startOn, endOn: '2026-11-03' });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.startOn).toBe(LEAVE_MESSAGES.date);
	});

	it('the window: 30 days back and 366 ahead are accepted, one more is not; spans over 366 refused', () => {
		expect(parse({ startOn: addDays(today, -30), endOn: addDays(today, -30) }).ok).toBe(true);
		const early = parse({ startOn: addDays(today, -31), endOn: addDays(today, -31) });
		expect(!early.ok && early.errors.startOn).toBe(LEAVE_MESSAGES.tooEarly);
		expect(parse({ startOn: addDays(today, 366), endOn: addDays(today, 366) }).ok).toBe(true);
		const late = parse({ startOn: addDays(today, 367), endOn: addDays(today, 367) });
		expect(!late.ok && late.errors.endOn).toBe(LEAVE_MESSAGES.tooLate);
		const long = parse({ startOn: addDays(today, -30), endOn: addDays(today, 366) });
		expect(!long.ok && long.errors.endOn).toBe(LEAVE_MESSAGES.tooLong);
		const far = parse({ startOn: '2100-12-31', endOn: '2100-12-31' });
		expect(far.ok).toBe(false);
		const reversed = parse({ startOn: '2026-11-03', endOn: '2026-11-02' });
		expect(!reversed.ok && reversed.errors.endOn).toBe(LEAVE_MESSAGES.order);
	});

	it('a balance type cannot cross New Year; a logged type can; a half day needs one date', () => {
		const split = parseRequest(
			form({ typeId: 'lt_annual', startOn: '2026-12-31', endOn: '2027-01-04' }),
			types,
			today
		);
		expect(!split.ok && split.errors.endOn).toBe(LEAVE_MESSAGES.split);
		const logged = parse({ startOn: '2026-12-31', endOn: '2027-01-04' });
		expect(logged.ok && logged.value.period).toBe(2026);
		const half = parse({ startOn: '2026-11-02', endOn: '2026-11-03', halfDay: 'am' });
		expect(!half.ok && half.errors.halfDay).toBe(LEAVE_MESSAGES.halfDay);
		// An unknown half-day value falls back to a full day, never to a smaller deduction.
		const odd = parse({ startOn: '2026-11-02', halfDay: 'evening' });
		expect(odd.ok && odd.value.halfDay).toBe('none');
	});

	it('inactive or unknown types are refused; Special needs a reason; reasons stop at 500', () => {
		expect(parse({ typeId: 'lt_old', startOn: '2026-11-02' }).ok).toBe(false);
		expect(parse({ typeId: 'lt_annual\u0000', startOn: '2026-11-02' }).ok).toBe(false);
		const special = parse({ typeId: 'lt_special', startOn: '2026-11-02' });
		expect(!special.ok && special.errors.reason).toBe(LEAVE_MESSAGES.reasonRequired);
		const long = parse({ startOn: '2026-11-02', reason: 'x'.repeat(501) });
		expect(!long.ok && long.errors.reason).toBe(LEAVE_MESSAGES.reasonTooLong);
		expect(parse({ startOn: '2026-11-02', reason: 'x'.repeat(500) }).ok).toBe(true);
	});
});

describe('settings parsers', () => {
	const form = (fields: Record<string, string> | [string, string][]) => {
		const f = new FormData();
		for (const [k, v] of Array.isArray(fields) ? fields : Object.entries(fields)) f.append(k, v);
		return f;
	};

	it('adjustments: -60..60 days in 0.5 steps, non-zero, note required; no exponent or hex tricks', () => {
		const base = { employeeId: 'e', typeId: 'lt_annual', period: '2026', note: 'carry-over' };
		expect(parseAdjustment(form({ ...base, days: '60' })).ok).toBe(true);
		expect(parseAdjustment(form({ ...base, days: '-60' })).ok).toBe(true);
		for (const days of ['60.5', '-61', '0', '1e2', '0x10', '1.25', 'NaN', '', '  ', '١'])
			expect(parseAdjustment(form({ ...base, days })).ok).toBe(false);
		expect(parseAdjustment(form({ ...base, days: '1', note: '' })).ok).toBe(false);
		expect(parseAdjustment(form({ ...base, days: '1', period: '1999' })).ok).toBe(false);
		expect(parseHalfDays('1.5')).toBe(3);
	});

	it('work days: a 7-day week and garbage are refused', () => {
		const all = ['1', '2', '3', '4', '5', '6', '7'].map((d) => ['day', d] as [string, string]);
		expect(parseWorkDays(form(all)).ok).toBe(false);
		expect(
			parseWorkDays(
				form([
					['day', '8'],
					['day', '0'],
					['day', '1.0']
				])
			).ok
		).toBe(false);
		expect(
			parseWorkDays(
				form([
					['day', '1'],
					['day', '1'],
					['day', '6']
				])
			)
		).toEqual({
			ok: true,
			value: [1, 6]
		});
	});
});

describe('merge check: throttle.ts', () => {
	it('RB-00 budgets unchanged; leave-request appended last, nothing else moved', () => {
		expect(THROTTLE_WINDOW_MS).toBe(10 * 60 * 1000);
		expect(THROTTLE_MINUTE_MS).toBe(60 * 1000);
		expect(THROTTLE_MAX_ATTEMPTS).toBe(20);
		expect(CLIENT_MAX_ATTEMPTS).toBe(100);
		// Later features append their own scopes after these (RB-12: `issue-report`).
		expect([...THROTTLE_SCOPES].slice(0, 11)).toEqual([
			'sign-in',
			'setup',
			'invite-accept',
			'account-password',
			'upload',
			'comment-create',
			'search',
			'mention-search',
			'hr-reveal',
			'hr-export',
			'leave-request'
		]);
		expect(LEAVE_LIMITS.requestsPerWindow).toBe(20);
	});
});

describe('CSRF on the time-off actions', () => {
	const post = (path: string, headers: Record<string, string>) =>
		new Request(`http://localhost${path}`, { method: 'POST', headers, body: 'id=x' });
	it.each([
		'/time-off?/request',
		'/time-off?/cancel',
		'/time-off/approvals?/approve',
		'/time-off/approvals?/reject',
		'/time-off/team?/cancel',
		'/time-off/settings?/adjust',
		'/time-off/settings?/holidayDelete'
	])('%s refuses cross-site and Origin-less form posts', (path) => {
		const type = { 'content-type': 'application/x-www-form-urlencoded' };
		expect(
			isCrossSiteForm(post(path, { ...type, origin: 'https://evil.example' }), 'http://localhost')
		).toBe(true);
		expect(isCrossSiteForm(post(path, type), 'http://localhost')).toBe(true);
		expect(
			isCrossSiteForm(
				post(path, { 'content-type': 'text/plain', origin: 'null' }),
				'http://localhost'
			)
		).toBe(true);
		expect(
			isCrossSiteForm(post(path, { ...type, origin: 'http://localhost' }), 'http://localhost')
		).toBe(false);
	});
});

describe('static scans of the RB-06 trees', () => {
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? walk(path) : [path];
		});
	const files = [
		...walk('src/lib/server/timeoff'),
		...walk('src/routes/(app)/time-off'),
		...walk('src/lib/ui/time-off')
	].filter((f) => !f.endsWith('.test.ts'));

	it('no {@html} anywhere in the time-off UI', () => {
		for (const f of files.filter((f) => f.endsWith('.svelte')))
			expect(readFileSync(f, 'utf8'), f).not.toMatch(/\{@html\s/);
	});

	it('no console logging in the time-off server code (no reasons, names or types in logs)', () => {
		for (const f of files.filter((f) => f.endsWith('.ts')))
			expect(readFileSync(f, 'utf8'), f).not.toMatch(/console\.(log|info|warn|error|debug)/);
	});

	it('every time-off load and action goes through requireViewer', () => {
		for (const f of files.filter(
			(f) => f.endsWith('+page.server.ts') || f.endsWith('+layout.server.ts')
		))
			expect(readFileSync(f, 'utf8'), f).toMatch(/requireViewer\(/);
	});
});
