import { describe, expect, it } from 'vitest';
import { formatDays, daysLabel } from '#lib/shared/time-off';
import type { Viewer } from '../hr/visibility';
import { annualEntitlement } from './accrual';
import {
	addDays,
	addMonths,
	countHalfDays,
	isoWeekday,
	monthRange,
	monthWeeks,
	monthsBetween
} from './calendar';
import { approverFor, canCancel, canDecide, isOverrideDecision } from './permissions';
import {
	parseAdjustment,
	parseHalfDays,
	parseHoliday,
	parseRequest,
	parseType,
	parseWorkDays,
	readWorkDays,
	type LeaveTypeInfo
} from './validation';

const MON_FRI = [1, 2, 3, 4, 5];
const count = (
	startOn: string,
	endOn: string,
	options: {
		halfDay?: 'none' | 'am' | 'pm';
		workDays?: number[];
		holidays?: { onDate: string; deductsLeave: boolean }[];
	} = {}
) =>
	countHalfDays({
		startOn,
		endOn,
		halfDay: options.halfDay ?? 'none',
		workDays: options.workDays ?? MON_FRI,
		holidays: options.holidays ?? []
	});

describe('calendar', () => {
	it('knows ISO weekdays without the local time zone', () => {
		expect(isoWeekday('2026-10-26')).toBe(1);
		expect(isoWeekday('2026-11-01')).toBe(7);
		expect(isoWeekday('2028-02-29')).toBe(2);
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
	});

	it('counts a Monday-to-Friday week as 5 days and skips the weekend in between', () => {
		expect(count('2026-10-26', '2026-10-30')).toEqual({
			halfDays: 10,
			skipped: { weekends: 0, holidays: 0 }
		});
		// Thursday to Wednesday over a weekend: 5 working days.
		expect(count('2026-10-29', '2026-11-04')).toEqual({
			halfDays: 10,
			skipped: { weekends: 2, holidays: 0 }
		});
	});

	it('skips a holiday that does not deduct and counts one that does', () => {
		expect(
			count('2026-10-26', '2026-10-30', {
				holidays: [{ onDate: '2026-10-28', deductsLeave: false }]
			})
		).toEqual({
			halfDays: 8,
			skipped: { weekends: 0, holidays: 1 }
		});
		expect(
			count('2026-10-26', '2026-10-30', {
				holidays: [{ onDate: '2026-10-28', deductsLeave: true }]
			}).halfDays
		).toBe(10);
		// A holiday on a weekend is a weekend day.
		expect(
			count('2026-10-31', '2026-10-31', {
				holidays: [{ onDate: '2026-10-31', deductsLeave: false }]
			}).skipped
		).toEqual({ weekends: 1, holidays: 0 });
	});

	it('gives 0 for a range of only weekend and holiday days', () => {
		expect(count('2026-10-31', '2026-11-01').halfDays).toBe(0);
		expect(
			count('2026-11-02', '2026-11-02', {
				holidays: [{ onDate: '2026-11-02', deductsLeave: false }]
			}).halfDays
		).toBe(0);
	});

	it('counts a half day as 1 and a half day on a weekend as 0', () => {
		expect(count('2026-10-27', '2026-10-27', { halfDay: 'am' }).halfDays).toBe(1);
		expect(count('2026-10-27', '2026-10-27', { halfDay: 'pm' }).halfDays).toBe(1);
		expect(count('2026-10-27', '2026-10-27').halfDays).toBe(2);
		expect(count('2026-10-31', '2026-10-31', { halfDay: 'am' }).halfDays).toBe(0);
	});

	it('handles a year boundary, a leap day and a 6-day week', () => {
		expect(count('2026-12-31', '2027-01-01').halfDays).toBe(4);
		expect(count('2028-02-28', '2028-03-01').halfDays).toBe(6);
		expect(count('2026-10-26', '2026-11-01', { workDays: [1, 2, 3, 4, 5, 6] }).halfDays).toBe(12);
	});

	it('builds month grids and shifts months', () => {
		const weeks = monthWeeks('2026-11');
		expect(weeks[0]).toEqual([null, null, null, null, null, null, '2026-11-01']);
		expect(weeks.flat().filter(Boolean)).toHaveLength(30);
		expect(weeks.every((w) => w.length === 7)).toBe(true);
		expect(monthRange('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
		expect(addMonths('2026-12', 1)).toBe('2027-01');
		expect(addMonths('2026-01', -1)).toBe('2025-12');
		expect(monthsBetween('2026-10', '2027-10')).toBe(12);
		expect(monthsBetween('2026-10', '2025-09')).toBe(-13);
	});
});

describe('annualEntitlement', () => {
	const e = (startOn: string | null, period: number) =>
		annualEntitlement({ startOn, period, annualHalfDays: 24 });
	it.each([
		['2026-03-01', 2026, 20],
		['2026-03-15', 2026, 18],
		['2026-03-01', 2027, 24],
		['2026-01-01', 2026, 24],
		['2026-01-02', 2026, 22],
		['2026-12-01', 2026, 2],
		['2026-12-15', 2026, 0],
		['2027-01-01', 2026, 0],
		['2020-06-10', 2026, 24],
		[null, 2026, 0]
	] as const)('start %s, year %i: %i half-days', (startOn, period, expected) => {
		expect(e(startOn, period)).toBe(expected);
	});
	it('prorates another yearly amount by whole half-days, rounded down', () => {
		expect(annualEntitlement({ startOn: '2026-03-15', period: 2026, annualHalfDays: 5 })).toBe(3);
	});
});

const TYPES: LeaveTypeInfo[] = [
	{ id: 'lt_annual', kind: 'balance', requiresReason: false, active: true },
	{ id: 'lt_sick', kind: 'logged', requiresReason: false, active: true },
	{ id: 'lt_special', kind: 'logged', requiresReason: true, active: true },
	{ id: 'lt_old', kind: 'logged', requiresReason: false, active: false }
];
const TODAY = '2026-10-26';
const formOf = (fields: Record<string, string>) => {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.append(k, v);
	return form;
};
const request = (fields: Record<string, string>) =>
	parseRequest(formOf({ typeId: 'lt_sick', halfDay: 'none', ...fields }), TYPES, TODAY);

describe('parseRequest', () => {
	it('accepts 30 days back and refuses 31', () => {
		expect(request({ startOn: addDays(TODAY, -30) }).ok).toBe(true);
		const late = request({ startOn: addDays(TODAY, -31) });
		expect(late.ok).toBe(false);
		if (!late.ok) expect(late.errors.startOn).toMatch(/30 days/);
	});
	it('accepts an end 366 days ahead and refuses 367', () => {
		const start = addDays(TODAY, 360);
		expect(request({ startOn: start, endOn: addDays(TODAY, 366) }).ok).toBe(true);
		const far = request({ startOn: start, endOn: addDays(TODAY, 367) });
		expect(far.ok).toBe(false);
		if (!far.ok) expect(far.errors.endOn).toMatch(/366 days/);
	});
	it('refuses impossible dates and an end before the start', () => {
		for (const startOn of ['2026-02-30', '2026-1-1', 'tomorrow', ''])
			expect(request({ startOn }).ok).toBe(false);
		expect(request({ startOn: '2026-11-03', endOn: '2026-11-02' }).ok).toBe(false);
	});
	it('refuses a balance request across 31 December with the split message; a logged one may cross', () => {
		const annual = request({ typeId: 'lt_annual', startOn: '2026-12-30', endOn: '2027-01-04' });
		expect(annual.ok).toBe(false);
		if (!annual.ok) expect(annual.errors.endOn).toMatch(/split it/);
		expect(request({ startOn: '2026-12-30', endOn: '2027-01-04' }).ok).toBe(true);
	});
	it('allows a half day only for a single date; an empty end means the start date', () => {
		expect(request({ startOn: '2026-11-02', endOn: '2026-11-03', halfDay: 'am' }).ok).toBe(false);
		const single = request({ startOn: '2026-11-02', endOn: '', halfDay: 'pm' });
		expect(single.ok && single.value).toMatchObject({
			endOn: '2026-11-02',
			halfDay: 'pm',
			period: 2026
		});
	});
	it('needs a reason for a type that requires one, caps it at 500 and refuses inactive or unknown types', () => {
		expect(request({ typeId: 'lt_special', startOn: '2026-11-02' }).ok).toBe(false);
		expect(request({ typeId: 'lt_special', startOn: '2026-11-02', reason: 'Wedding' }).ok).toBe(
			true
		);
		expect(request({ startOn: '2026-11-02', reason: 'x'.repeat(501) }).ok).toBe(false);
		expect(request({ startOn: '2026-11-02', reason: 'x'.repeat(500) }).ok).toBe(true);
		expect(request({ typeId: 'lt_old', startOn: '2026-11-02' }).ok).toBe(false);
		expect(request({ typeId: 'nope', startOn: '2026-11-02' }).ok).toBe(false);
	});
	it('stores a reason as plain single-line text', () => {
		const r = request({ startOn: '2026-11-02', reason: '<script>alert(1)</script>​ **bold**' });
		expect(r.ok && r.value.reason).toBe('<script>alert(1)</script> **bold**');
	});
});

describe('other forms', () => {
	it('parses days in 0.5 steps as half-days', () => {
		expect(parseHalfDays('1')).toBe(2);
		expect(parseHalfDays('1.5')).toBe(3);
		expect(parseHalfDays('-0.5')).toBe(-1);
		expect(parseHalfDays('+2.0')).toBe(4);
		for (const bad of ['1.25', '1,5', 'abc', '', '1e3', '0x10'])
			expect(parseHalfDays(bad)).toBeNull();
	});
	it('bounds adjustments: non-zero, -60..60 days, note required', () => {
		const adj = (days: string, note = 'Carry-over') =>
			parseAdjustment(formOf({ employeeId: 'E', typeId: 'lt_annual', period: '2026', days, note }));
		expect(adj('60').ok).toBe(true);
		expect(adj('-60').ok).toBe(true);
		expect(adj('60.5').ok).toBe(false);
		expect(adj('0').ok).toBe(false);
		expect(adj('2', '').ok).toBe(false);
		expect(adj('2', 'x'.repeat(201)).ok).toBe(false);
		const ok = adj('-1.5');
		expect(ok.ok && ok.value.halfDays).toBe(-3);
	});
	it('refuses a 7-day week and an empty one; reads the stored list defensively', () => {
		const days = (list: string[]) => {
			const form = new FormData();
			for (const d of list) form.append('day', d);
			return parseWorkDays(form);
		};
		expect(days(['1', '2', '3', '4', '5', '6', '7']).ok).toBe(false);
		expect(days([]).ok).toBe(false);
		expect(days(['8', 'x']).ok).toBe(false);
		const six = days(['6', '1', '2', '3', '4', '5', '5']);
		expect(six.ok && six.value).toEqual([1, 2, 3, 4, 5, 6]);
		expect(readWorkDays('1,2,3,4,5')).toEqual([1, 2, 3, 4, 5]);
		expect(readWorkDays('1,2,3,4,5,6,7')).toEqual([1, 2, 3, 4, 5]);
		expect(readWorkDays(null)).toEqual([1, 2, 3, 4, 5]);
	});
	it('validates holidays and types', () => {
		expect(parseHoliday(formOf({ onDate: '2026-12-25', name: 'Christmas Day' })).ok).toBe(true);
		expect(parseHoliday(formOf({ onDate: '1999-12-25', name: 'Old' })).ok).toBe(false);
		expect(parseHoliday(formOf({ onDate: '2026-12-25', name: 'x'.repeat(81) })).ok).toBe(false);
		const t = parseType(formOf({ name: 'Study', kind: 'balance', annualDays: '3.5' }), true);
		expect(t.ok && t.value).toMatchObject({ annualHalfDays: 7, kind: 'balance', active: true });
		expect(parseType(formOf({ name: 'Study', kind: 'balance', annualDays: '366' }), true).ok).toBe(
			false
		);
		expect(parseType(formOf({ name: '', kind: 'logged' }), true).ok).toBe(false);
		expect(parseType(formOf({ name: 'x', kind: 'weird' }), true).ok).toBe(false);
	});
	it('formats half-days as days', () => {
		expect(formatDays(24)).toBe('12');
		expect(formatDays(3)).toBe('1.5');
		expect(formatDays(-1)).toBe('-0.5');
		expect(formatDays(0)).toBe('0');
		expect(daysLabel(2)).toBe('1 day');
		expect(daysLabel(5)).toBe('2.5 days');
	});
});

const viewer = (overrides: Partial<Viewer> = {}): Viewer => ({
	userId: 'actor',
	isHr: false,
	isAdmin: false,
	ownEmployeeId: null,
	...overrides
});

describe('canDecide', () => {
	const ctx = (overrides: Partial<Parameters<typeof canDecide>[1]> = {}) => ({
		requesterUserId: 'requester',
		employeeUserId: 'requester',
		managerUserId: 'manager' as string | null,
		otherHrExists: true,
		...overrides
	});
	it.each([
		['the manager', viewer({ userId: 'manager' }), ctx(), true],
		['another manager', viewer({ userId: 'other-manager', ownEmployeeId: 'x' }), ctx(), false],
		['the requester', viewer({ userId: 'requester' }), ctx(), false],
		['the requester who is HR', viewer({ userId: 'requester', isHr: true }), ctx(), false],
		['a plain member', viewer(), ctx(), false],
		['HR', viewer({ isHr: true }), ctx(), true],
		['an admin while a manager exists', viewer({ isAdmin: true }), ctx(), false],
		[
			'an admin while other HR exists',
			viewer({ isAdmin: true }),
			ctx({ managerUserId: null }),
			false
		],
		[
			'an admin with no manager and no other HR',
			viewer({ isAdmin: true }),
			ctx({ managerUserId: null, otherHrExists: false }),
			true
		],
		[
			'the requester while another admin exists (an eligible approver)',
			viewer({ userId: 'requester', isAdmin: true }),
			ctx({ managerUserId: null, otherHrExists: false, otherAdminExists: true }),
			false
		],
		[
			'the requester when nobody else can approve (self-approval)',
			viewer({ userId: 'requester', isAdmin: true, isHr: true }),
			ctx({ managerUserId: null, otherHrExists: false, otherAdminExists: false }),
			true
		],
		[
			'the requester once a second HR user exists',
			viewer({ userId: 'requester', isAdmin: true, isHr: true }),
			ctx({ managerUserId: null, otherHrExists: true, otherAdminExists: false }),
			false
		],
		[
			'the requester once a manager account exists',
			viewer({ userId: 'requester', isAdmin: true, isHr: true }),
			ctx({ otherHrExists: false, otherAdminExists: false }),
			false
		],
		[
			'a relinked record: the submitter who is no longer linked',
			viewer({ userId: 'requester', isAdmin: true }),
			ctx({
				employeeUserId: 'someone-else',
				managerUserId: null,
				otherHrExists: false,
				otherAdminExists: false
			}),
			false
		]
	] as const)('%s → %s', (_, actor, context, expected) => {
		expect(canDecide(actor, context)).toBe(expected);
	});
	it('names the designated approver and flags HR overrides', () => {
		expect(approverFor({ managerUserId: 'm', otherHrExists: false })).toBe('manager');
		expect(approverFor({ managerUserId: null, otherHrExists: true })).toBe('hr');
		expect(approverFor({ managerUserId: null, otherHrExists: false })).toBe('admin');
		expect(
			approverFor({ managerUserId: null, otherHrExists: false, otherAdminExists: false })
		).toBe('self');
		expect(isOverrideDecision(viewer({ isHr: true }), ctx())).toBe(true);
		expect(isOverrideDecision(viewer({ isHr: true }), ctx({ managerUserId: null }))).toBe(false);
		expect(isOverrideDecision(viewer({ userId: 'manager', isHr: true }), ctx())).toBe(false);
	});
});

describe('canCancel', () => {
	const req = (
		status: 'pending' | 'approved' | 'rejected' | 'canceled',
		startOn: string,
		employeeId = 'e-actor'
	) => ({
		status,
		startOn,
		employeeId
	});
	const me = (flags: Partial<Viewer> = {}) => viewer({ ownEmployeeId: 'e-actor', ...flags });
	it.each([
		['own pending, started', me(), req('pending', '2026-10-01'), 'self'],
		['own approved, future', me(), req('approved', '2026-10-27'), 'self'],
		['own approved, starts today', me(), req('approved', '2026-10-26'), null],
		['own approved, started, HR', me({ isHr: true }), req('approved', '2026-10-01'), 'override'],
		['someone else’s, member', me(), req('pending', '2026-11-01', 'other'), null],
		['someone else’s, HR', me({ isHr: true }), req('approved', '2026-10-01', 'other'), 'override'],
		[
			'submitted by me, but the record is now linked to someone else',
			viewer(),
			req('pending', '2026-11-01'),
			null
		],
		['rejected', me({ isHr: true }), req('rejected', '2026-11-01'), null],
		['canceled', me(), req('canceled', '2026-11-01'), null]
	] as const)('%s → %s', (_, actor, request, expected) => {
		expect(canCancel(actor, request, '2026-10-26')).toBe(expected);
	});
});
