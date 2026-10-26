import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import { requireViewer } from '#lib/server/hr/access';
import { teamMembers } from '#lib/server/timeoff/repo';
import { yearOf } from '#lib/server/timeoff/calendar';
import {
	addHoliday,
	adjust,
	createType,
	deleteHoliday,
	getWorkDays,
	grantYear,
	listHolidays,
	listTypes,
	saveWorkDays,
	updateType,
	type SettingsWrite
} from '#lib/server/timeoff/repo';
import {
	LEAVE_LIMITS,
	parseAdjustment,
	parseHoliday,
	parseType,
	parseWorkDays,
	parseYear
} from '#lib/server/timeoff/validation';
import { isUuid, parseExpected } from '#lib/server/tasks/validation';
import { teamToday } from '#lib/server/tasks/today';
import { now } from '#lib/server/util';
import { formatDays } from '#lib/shared/time-off';
import type { Actions, PageServerLoad } from './$types';

const NOT_FOUND = 'Page not found.';
const CHANGED = 'This was changed meanwhile. The page now shows the current version.';

/** HR only; anyone else gets the same 404 as a missing page. */
async function hr(event: Pick<RequestEvent, 'locals'>) {
	const found = await requireViewer(event);
	if (!found.viewer.isHr) error(404, NOT_FOUND);
	return found;
}

export const load: PageServerLoad = async (event) => {
	const { viewer } = await hr(event);
	const db = event.locals.db;
	const thisYear = yearOf(teamToday());
	const year = parseYear(event.url.searchParams.get('year')) ?? thisYear;
	const [types, holidays, workDays, members, thisYearHolidays] = await Promise.all([
		listTypes(db),
		listHolidays(db, `${year}-01-01`, `${year}-12-31`),
		getWorkDays(db),
		teamMembers(db, viewer),
		year === thisYear ? null : listHolidays(db, `${thisYear}-01-01`, `${thisYear}-12-31`)
	]);
	return {
		year,
		thisYear,
		years: [thisYear - 1, thisYear, thisYear + 1],
		types: types.map((t) => ({
			id: t.id,
			name: t.name,
			kind: t.kind,
			annualDays: formatDays(t.annualHalfDays),
			requiresReason: t.requiresReason,
			active: t.active,
			updatedAt: t.updatedAt
		})),
		typesFull: types.length >= LEAVE_LIMITS.typesMax,
		holidays: holidays.map((h) => ({
			id: h.id,
			onDate: h.onDate,
			name: h.name,
			deductsLeave: h.deductsLeave
		})),
		noHolidaysThisYear: (thisYearHolidays ?? holidays).length === 0,
		workDays: workDays.days,
		workDaysUpdatedAt: workDays.updatedAt,
		employees: members
	};
};

const refused = (section: string, result: SettingsWrite, messages: Record<string, string>) => {
	if (result.ok) return null;
	if (result.reason === 'not_found') error(404, NOT_FOUND);
	return fail(409, { section, error: messages[result.reason] ?? CHANGED });
};

export const actions: Actions = {
	typeSave: async (event) => {
		const { viewer } = await hr(event);
		const db = event.locals.db;
		const form = await readFormBody(event.request);
		const id = textField(form, 'id').trim();
		const parsed = parseType(form, id === '');
		if (!parsed.ok)
			return fail(400, { section: id ? `type:${id}` : 'type', errors: parsed.errors });
		const messages = {
			duplicate: 'A leave type with that name exists.',
			full: `There can be at most ${LEAVE_LIMITS.typesMax} leave types.`,
			changed: CHANGED
		};
		if (!id) {
			const result = await createType(db, viewer.userId, parsed.value, now());
			return refused('type', result, messages) ?? { section: 'type', saved: 'Leave type added.' };
		}
		const current = (await listTypes(db)).find((t) => t.id === id);
		if (!current) error(404, NOT_FOUND);
		const expected = parseExpected(textField(form, 'expected'));
		if (expected === null) return fail(409, { section: `type:${id}`, error: CHANGED });
		const result = await updateType(db, viewer.userId, current, parsed.value, expected, now());
		return (
			refused(`type:${id}`, result, messages) ?? {
				section: `type:${id}`,
				saved: 'Leave type saved.'
			}
		);
	},

	holidaySave: async (event) => {
		const { viewer } = await hr(event);
		const form = await readFormBody(event.request);
		const parsed = parseHoliday(form);
		if (!parsed.ok) return fail(400, { section: 'holiday', errors: parsed.errors });
		const result = await addHoliday(event.locals.db, viewer.userId, parsed.value, now());
		return (
			refused('holiday', result, {
				duplicate: 'There is already a holiday on that date.',
				full: `A year holds at most ${LEAVE_LIMITS.holidaysPerYear} holidays.`
			}) ?? { section: 'holiday', saved: 'Holiday added.' }
		);
	},

	holidayDelete: async (event) => {
		const { viewer } = await hr(event);
		const form = await readFormBody(event.request);
		const id = textField(form, 'id').trim().toLowerCase();
		if (!isUuid(id)) error(404, NOT_FOUND);
		const result = await deleteHoliday(event.locals.db, viewer.userId, id, now());
		return refused('holiday', result, {}) ?? { section: 'holiday', saved: 'Holiday removed.' };
	},

	workDays: async (event) => {
		const { viewer } = await hr(event);
		const form = await readFormBody(event.request);
		const parsed = parseWorkDays(form);
		if (!parsed.ok) return fail(400, { section: 'workDays', errors: parsed.errors });
		const expected = parseExpected(textField(form, 'expected'));
		if (expected === null) return fail(409, { section: 'workDays', error: CHANGED });
		const result = await saveWorkDays(
			event.locals.db,
			viewer.userId,
			parsed.value,
			expected,
			now()
		);
		return refused('workDays', result, {}) ?? { section: 'workDays', saved: 'Work days saved.' };
	},

	adjust: async (event) => {
		const { viewer } = await hr(event);
		const form = await readFormBody(event.request);
		const parsed = parseAdjustment(form);
		if (!parsed.ok) return fail(400, { section: 'adjust', errors: parsed.errors });
		const result = await adjust(event.locals.db, viewer, parsed.value, now());
		if (result.ok) return { section: 'adjust', saved: 'Balance adjusted.' };
		if (result.reason === 'not_found')
			return fail(400, {
				section: 'adjust',
				errors: { employeeId: 'Choose an employee and a leave type with a balance.' }
			});
		return fail(409, {
			section: 'adjust',
			error: `That would take the balance below zero: ${formatDays(Math.max(0, result.available ?? 0))} days available.`
		});
	},

	grantYear: async (event) => {
		const { viewer } = await hr(event);
		const form = await readFormBody(event.request);
		const year = parseYear(textField(form, 'year'));
		const thisYear = yearOf(teamToday());
		if (year === null || year < thisYear - 1 || year > thisYear + 1)
			return fail(400, { section: 'grant', error: 'Choose this year, last year or next year.' });
		const written = await grantYear(event.locals.db, viewer.userId, year, now());
		return {
			section: 'grant',
			saved:
				written === 0
					? `Every entitlement for ${year} was already granted.`
					: `Granted ${year} entitlements (${written} ${written === 1 ? 'entry' : 'entries'}).`
		};
	}
};
