import { HALF_DAY_PARTS, LEAVE_KINDS, type HalfDayPart, type LeaveKind } from '#lib/shared/enums';
import { checkboxField, oneOfField, textField } from '../forms';
import { isCalendarDate } from '../tasks/dates';
import { cleanLine } from '../tasks/validation';
import { addDays, spanDays, yearOf } from './calendar';

/** Every RB-06 bound (PRD › Validation). Half-days are integers; forms take days in 0.5 steps. */
export const LEAVE_LIMITS = {
	pastDays: 30,
	futureDays: 366,
	spanDays: 366,
	pendingMax: 10,
	reason: 500,
	note: 500,
	adjustHalfDays: 120,
	adjustNote: 200,
	holidayName: 80,
	holidaysPerYear: 40,
	holidayMin: '2000-01-01',
	holidayMax: '2100-12-31',
	typeName: 40,
	typesMax: 20,
	annualHalfDaysMax: 730,
	workDaysMax: 6,
	/** Leave requests per user per throttle window (THROTTLE_WINDOW_MS, 10 minutes). */
	requestsPerWindow: 20,
	listMax: 200,
	calendarRows: 1000,
	calendarMonthsAround: 12
} as const;

export const LEAVE_MESSAGES = {
	type: 'Choose a leave type.',
	date: 'Enter a real date.',
	order: 'The end date must be on or after the start date.',
	tooEarly: `Leave can start at most ${LEAVE_LIMITS.pastDays} days in the past.`,
	tooLate: `Leave can end at most ${LEAVE_LIMITS.futureDays} days ahead.`,
	tooLong: `A request covers at most ${LEAVE_LIMITS.spanDays} days.`,
	halfDay: 'A half day is possible only when the start and end date are the same.',
	split: 'This leave counts against a yearly balance: split it into one request per calendar year.',
	noWorkDays: 'That range has no working days.',
	reasonRequired: 'Give a reason for this leave type.',
	reasonTooLong: `Keep the reason to ${LEAVE_LIMITS.reason} characters.`,
	noteTooLong: `Keep the note to ${LEAVE_LIMITS.note} characters.`,
	overlap: 'You already have leave on those dates.',
	pendingMax: `You have ${LEAVE_LIMITS.pendingMax} pending requests. Wait for a decision or cancel one first.`,
	decided: 'This request was already decided.',
	changed: 'This request was changed meanwhile. The page now shows the current version.',
	beforeStart: 'Leave can start on or after your start date.',
	selfApproval: 'No one else can approve your requests yet; you can approve them yourself (logged).'
} as const;

export type Errors = Record<string, string>;

/** Days in 0.5 steps (`"1"`, `"1.5"`, `"-2"`), as signed half-days; null when malformed. */
export function parseHalfDays(raw: string): number | null {
	const m = /^([+-]?)(\d{1,3})(?:\.(0|5))?$/.exec(raw.trim());
	if (!m) return null;
	const n = Number(m[2]) * 2 + (m[3] === '5' ? 1 : 0);
	return m[1] === '-' ? -n : n;
}

/** A positive or zero integer year in the supported range, else null. */
export function parseYear(raw: string | null): number | null {
	if (!raw || !/^\d{4}$/.test(raw)) return null;
	const year = Number(raw);
	return year >= 2000 && year <= 2100 ? year : null;
}

export interface LeaveTypeInfo {
	id: string;
	kind: LeaveKind;
	requiresReason: boolean;
	active: boolean;
}

export interface RequestInput {
	typeId: string;
	startOn: string;
	endOn: string;
	halfDay: HalfDayPart;
	reason: string;
	period: number;
	kind: LeaveKind;
}

export type ParsedRequest =
	{ ok: true; value: RequestInput } | { ok: false; errors: Errors; echo: Record<string, string> };

/**
 * The request form (type, start, end, half day, reason) against the active types and the team's `today`.
 * Working-day counting happens later, with the stored holidays.
 */
export function parseRequest(
	form: FormData,
	types: readonly LeaveTypeInfo[],
	today: string
): ParsedRequest {
	const errors: Errors = {};
	const typeId = textField(form, 'typeId');
	const type = types.find((t) => t.id === typeId && t.active);
	if (!type) errors.typeId = LEAVE_MESSAGES.type;
	const startOn = textField(form, 'startOn').trim();
	const endRaw = textField(form, 'endOn').trim();
	const endOn = endRaw || startOn;
	const halfDay = oneOfField(form, 'halfDay', HALF_DAY_PARTS) ?? 'none';
	const reasonLine = cleanLine(textField(form, 'reason'), LEAVE_LIMITS.reason);
	const echo = { typeId, startOn, endOn: endRaw, halfDay, reason: reasonLine.value };

	const min = addDays(today, -LEAVE_LIMITS.pastDays);
	const max = addDays(today, LEAVE_LIMITS.futureDays);
	const startOk = isCalendarDate(startOn, '2000-01-01', '2100-12-31');
	const endOk = isCalendarDate(endOn, '2000-01-01', '2100-12-31');
	if (!startOk) errors.startOn = LEAVE_MESSAGES.date;
	if (!endOk) errors.endOn = LEAVE_MESSAGES.date;
	if (startOk && endOk) {
		if (endOn < startOn) errors.endOn = LEAVE_MESSAGES.order;
		else if (startOn < min) errors.startOn = LEAVE_MESSAGES.tooEarly;
		else if (endOn > max) errors.endOn = LEAVE_MESSAGES.tooLate;
		else if (spanDays(startOn, endOn) > LEAVE_LIMITS.spanDays)
			errors.endOn = LEAVE_MESSAGES.tooLong;
		else if (halfDay !== 'none' && startOn !== endOn) errors.halfDay = LEAVE_MESSAGES.halfDay;
		else if (type?.kind === 'balance' && yearOf(startOn) !== yearOf(endOn))
			errors.endOn = LEAVE_MESSAGES.split;
	}
	if (reasonLine.tooLong) errors.reason = LEAVE_MESSAGES.reasonTooLong;
	else if (type?.requiresReason && !reasonLine.value) errors.reason = LEAVE_MESSAGES.reasonRequired;

	if (Object.keys(errors).length || !type) return { ok: false, errors, echo };
	return {
		ok: true,
		value: {
			typeId: type.id,
			startOn,
			endOn,
			halfDay,
			reason: reasonLine.value,
			period: yearOf(startOn),
			kind: type.kind
		}
	};
}

/** An approver's or canceller's note, 0–500 characters; null when too long. */
export function parseNote(form: FormData): string | null {
	const line = cleanLine(textField(form, 'note'), LEAVE_LIMITS.note);
	return line.tooLong ? null : line.value;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: Errors };

export function parseAdjustment(
	form: FormData
): Parsed<{ employeeId: string; typeId: string; period: number; halfDays: number; note: string }> {
	const errors: Errors = {};
	const employeeId = textField(form, 'employeeId').trim().toLowerCase();
	const typeId = textField(form, 'typeId').trim();
	const period = parseYear(textField(form, 'period'));
	const halfDays = parseHalfDays(textField(form, 'days'));
	const note = cleanLine(textField(form, 'note'), LEAVE_LIMITS.adjustNote);
	if (!employeeId) errors.employeeId = 'Choose an employee.';
	if (!typeId) errors.typeId = LEAVE_MESSAGES.type;
	if (period === null) errors.period = 'Enter a year between 2000 and 2100.';
	if (halfDays === null || halfDays === 0 || Math.abs(halfDays) > LEAVE_LIMITS.adjustHalfDays)
		errors.days = `Enter a non-zero number of days between -${LEAVE_LIMITS.adjustHalfDays / 2} and ${LEAVE_LIMITS.adjustHalfDays / 2}, in steps of 0.5.`;
	if (note.tooLong) errors.note = `Keep the note to ${LEAVE_LIMITS.adjustNote} characters.`;
	else if (!note.value) errors.note = 'Say why the balance changes.';
	if (Object.keys(errors).length) return { ok: false, errors };
	return {
		ok: true,
		value: { employeeId, typeId, period: period!, halfDays: halfDays!, note: note.value }
	};
}

export function parseHoliday(
	form: FormData
): Parsed<{ onDate: string; name: string; deductsLeave: boolean }> {
	const errors: Errors = {};
	const onDate = textField(form, 'onDate').trim();
	const name = cleanLine(textField(form, 'name'), LEAVE_LIMITS.holidayName);
	if (!isCalendarDate(onDate, LEAVE_LIMITS.holidayMin, LEAVE_LIMITS.holidayMax))
		errors.onDate = 'Enter a real date between 2000 and 2100.';
	if (!name.value) errors.name = 'Name the holiday.';
	else if (name.tooLong) errors.name = `Keep the name to ${LEAVE_LIMITS.holidayName} characters.`;
	if (Object.keys(errors).length) return { ok: false, errors };
	return {
		ok: true,
		value: { onDate, name: name.value, deductsLeave: checkboxField(form, 'deductsLeave') }
	};
}

export interface TypeInput {
	name: string;
	kind: LeaveKind;
	annualHalfDays: number;
	requiresReason: boolean;
	active: boolean;
}

/** A leave type: name 1–40, yearly days 0–365 in 0.5 steps (balance types only), `kind` only when created. */
export function parseType(form: FormData, creating: boolean): Parsed<TypeInput> {
	const errors: Errors = {};
	const name = cleanLine(textField(form, 'name'), LEAVE_LIMITS.typeName);
	const kind = creating ? oneOfField(form, 'kind', LEAVE_KINDS) : 'balance';
	const annualRaw = textField(form, 'annualDays').trim();
	const annual = annualRaw === '' ? 0 : parseHalfDays(annualRaw);
	if (!name.value) errors.name = 'Name the leave type.';
	else if (name.tooLong) errors.name = `Keep the name to ${LEAVE_LIMITS.typeName} characters.`;
	if (!kind) errors.kind = 'Choose how this leave is counted.';
	if (annual === null || annual < 0 || annual > LEAVE_LIMITS.annualHalfDaysMax)
		errors.annualDays = 'Enter 0 to 365 days a year, in steps of 0.5.';
	if (Object.keys(errors).length) return { ok: false, errors };
	return {
		ok: true,
		value: {
			name: name.value,
			kind: kind!,
			annualHalfDays: annual!,
			requiresReason: checkboxField(form, 'requiresReason'),
			active: creating || checkboxField(form, 'active')
		}
	};
}

/** Work days from the checkbox list `day` (ISO weekdays 1–7): non-empty, at most 6. */
export function parseWorkDays(form: FormData): Parsed<number[]> {
	const days = [
		...new Set(
			form
				.getAll('day')
				.filter((v): v is string => typeof v === 'string' && /^[1-7]$/.test(v))
				.map(Number)
		)
	].sort((a, b) => a - b);
	if (days.length === 0) return { ok: false, errors: { days: 'Choose at least one work day.' } };
	if (days.length > LEAVE_LIMITS.workDaysMax)
		return { ok: false, errors: { days: 'Keep at least one day of the week free.' } };
	return { ok: true, value: days };
}

/** The stored `work_days` value (`"1,2,3,4,5"`), defaulting to Monday–Friday when unreadable. */
export function readWorkDays(value: string | null | undefined): number[] {
	const days = [
		...new Set(
			(value ?? '')
				.split(',')
				.filter((v) => /^[1-7]$/.test(v.trim()))
				.map((v) => Number(v.trim()))
		)
	].sort((a, b) => a - b);
	return days.length && days.length <= LEAVE_LIMITS.workDaysMax ? days : [1, 2, 3, 4, 5];
}
