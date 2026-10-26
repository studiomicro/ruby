import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { LAST4_FIELDS, SENSITIVE_FIELDS, SENSITIVE_FIELD_LABELS } from '#lib/shared/enums';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { hrKey, KEY_NOT_CONFIGURED, requireHr } from '#lib/server/hr/access';
import {
	addCompensation,
	getEmployee,
	linkUser,
	listActiveEmployees,
	listLinkableUsers,
	privateSummary,
	reinstate,
	restore,
	softDelete,
	terminate,
	unlinkUser,
	updatePrivate,
	updateWork,
	type HrWrite
} from '#lib/server/hr/repo';
import {
	HR_LIMITS,
	isUuid,
	parseCompensation,
	parseExpected,
	parsePrivate,
	parseTerminate,
	parseWork,
	PRIVATE_FIELDS
} from '#lib/server/hr/validation';
import { maskLast4 } from '#lib/server/hr/visibility';
import { checkboxField } from '#lib/server/forms';
import { todayIn } from '#lib/server/tasks/dates';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

const NOT_FOUND = 'Employee not found.';
const CHANGED = 'This employee was changed meanwhile. The page now shows the current version.';

/** HR only (403 for anyone else, before any id is looked up); the employee in any state, else 404. */
async function target(event: Pick<RequestEvent, 'locals' | 'params'>) {
	const { user } = await requireHr(event);
	const id = (event.params.id ?? '').toLowerCase();
	if (!isUuid(id)) error(404, NOT_FOUND);
	const employee = await getEmployee(event.locals.db, id);
	if (!employee) error(404, NOT_FOUND);
	return { user, employee };
}

export const load: PageServerLoad = async (event) => {
	const { employee: e } = await target(event);
	const db = event.locals.db;
	const [managers, users, summary, key] = await Promise.all([
		listActiveEmployees(db),
		listLinkableUsers(db),
		privateSummary(db, e.id),
		hrKey()
	]);
	return {
		employee: e,
		managers: managers
			.filter((m) => m.id !== e.id)
			.map((m) => ({ id: m.id, name: m.jobTitle ? `${m.fullName} — ${m.jobTitle}` : m.fullName })),
		users,
		personal: {
			updatedAt: summary.updatedAt,
			bankName: summary.bankName,
			fields: SENSITIVE_FIELDS.map((field) => ({
				field,
				label: SENSITIVE_FIELD_LABELS[field],
				set: summary.set[field],
				masked: (LAST4_FIELDS as readonly string[]).includes(field)
					? maskLast4(summary.last4[field as (typeof LAST4_FIELDS)[number]])
					: summary.set[field]
						? 'Hidden'
						: 'Not set'
			}))
		},
		keyReady: key !== null,
		today: todayIn(getEnv().TEAM_TIME_ZONE, now())
	};
};

/** The form answer of a refused employee write; `section` names which form shows it. */
function refused(result: Exclude<HrWrite, { ok: true }>, section: string, values?: object) {
	if (result.reason === 'not_found') error(404, NOT_FOUND);
	if (result.reason === 'conflict') return fail(409, { section, errors: { form: CHANGED } });
	return fail(400, { section, errors: result.errors, values });
}

async function expectedOf(form: FormData) {
	return parseExpected(textField(form, 'expectedUpdatedAt'));
}

export const actions: Actions = {
	updateWork: async (event) => {
		const { user, employee } = await target(event);
		if (employee.deletedAt !== null) error(404, NOT_FOUND);
		const form = await readFormBody(event.request, HR_LIMITS.formBodyMax);
		const expected = await expectedOf(form);
		if (expected === null) return fail(400, { section: 'work', errors: { form: CHANGED } });
		const parsed = parseWork(form);
		if (!parsed.ok)
			return fail(400, { section: 'work', errors: parsed.errors, values: parsed.echo });
		const result = await updateWork(
			event.locals.db,
			user.id,
			employee,
			parsed.value,
			expected,
			now()
		);
		if (result.ok) return { section: 'work', saved: 'Work and employment saved.' };
		return refused(result, 'work', parsed.value);
	},

	/** Tier 2 values, encrypted; refused (503) while HR_DATA_KEY is not configured. Blank inputs keep values. */
	updateSensitive: async (event) => {
		const { user, employee } = await target(event);
		if (employee.deletedAt !== null) error(404, NOT_FOUND);
		const key = await hrKey();
		if (!key) return fail(503, { section: 'sensitive', errors: { form: KEY_NOT_CONFIGURED } });
		const form = await readFormBody(event.request, HR_LIMITS.formBodyMax);
		const expected = await expectedOf(form);
		if (expected === null) return fail(400, { section: 'sensitive', errors: { form: CHANGED } });
		const at = now();
		const parsed = parsePrivate(form, PRIVATE_FIELDS, todayIn(getEnv().TEAM_TIME_ZONE, at));
		if (!parsed.ok) return fail(400, { section: 'sensitive', errors: parsed.errors });
		const result = await updatePrivate(
			event.locals.db,
			key,
			user.id,
			employee.id,
			parsed.changes,
			expected,
			at
		);
		if (result.ok) return { section: 'sensitive', saved: 'Sensitive details saved.' };
		if (result.reason === 'not_found') error(404, NOT_FOUND);
		return fail(409, { section: 'sensitive', errors: { form: CHANGED } });
	},

	addCompensation: async (event) => {
		const { user, employee } = await target(event);
		if (employee.deletedAt !== null) error(404, NOT_FOUND);
		const key = await hrKey();
		if (!key) return fail(503, { section: 'salary', errors: { form: KEY_NOT_CONFIGURED } });
		const form = await readFormBody(event.request, HR_LIMITS.formBodyMax);
		const parsed = parseCompensation(form);
		if (!parsed.ok)
			return fail(400, { section: 'salary', errors: parsed.errors, values: parsed.echo });
		const result = await addCompensation(
			event.locals.db,
			key,
			user.id,
			employee.id,
			parsed.value,
			now()
		);
		if (!result.ok) error(404, NOT_FOUND);
		return { section: 'salary', saved: 'Salary record added.' };
	},

	linkUser: async (event) => {
		const { user, employee } = await target(event);
		const form = await readFormBody(event.request);
		const expected = await expectedOf(form);
		const userId = textField(form, 'userId').trim().toLowerCase();
		if (expected === null) return fail(400, { section: 'account', errors: { form: CHANGED } });
		if (!isUuid(userId))
			return fail(400, { section: 'account', errors: { userId: 'Choose an account.' } });
		const result = await linkUser(event.locals.db, user.id, employee.id, userId, expected, now());
		if (result.ok) return { section: 'account', saved: 'Account linked.' };
		return refused(result, 'account');
	},

	unlinkUser: async (event) => {
		const { user, employee } = await target(event);
		const form = await readFormBody(event.request);
		const expected = await expectedOf(form);
		if (expected === null) return fail(400, { section: 'account', errors: { form: CHANGED } });
		const result = await unlinkUser(event.locals.db, user.id, employee, expected, now());
		if (result.ok) return { section: 'account', saved: 'Account unlinked.' };
		return refused(result, 'account');
	},

	terminate: async (event) => {
		const { user, employee } = await target(event);
		if (employee.deletedAt !== null) error(404, NOT_FOUND);
		const form = await readFormBody(event.request);
		const expected = await expectedOf(form);
		if (expected === null) return fail(400, { section: 'status', errors: { form: CHANGED } });
		const parsed = parseTerminate(form, employee.startOn);
		if (!parsed.ok)
			return fail(400, { section: 'status', errors: parsed.errors, values: parsed.echo });
		const result = await terminate(
			event.locals.db,
			user.id,
			employee,
			parsed.value.endOn,
			expected,
			now()
		);
		if (result.ok) return { section: 'status', saved: 'Employee terminated.' };
		return refused(result, 'status', parsed.value);
	},

	reinstate: async (event) => {
		const { user, employee } = await target(event);
		if (employee.deletedAt !== null) error(404, NOT_FOUND);
		const form = await readFormBody(event.request);
		const expected = await expectedOf(form);
		if (expected === null) return fail(400, { section: 'status', errors: { form: CHANGED } });
		const result = await reinstate(event.locals.db, user.id, employee, expected, now());
		if (result.ok) return { section: 'status', saved: 'Employee reinstated.' };
		return refused(result, 'status');
	},

	delete: async (event) => {
		const { user, employee } = await target(event);
		const form = await readFormBody(event.request);
		const expected = await expectedOf(form);
		if (expected === null) return fail(400, { section: 'delete', errors: { form: CHANGED } });
		if (!checkboxField(form, 'confirm'))
			return fail(400, { section: 'delete', errors: { confirm: 'Tick the box to confirm.' } });
		const result = await softDelete(event.locals.db, user.id, employee.id, expected, now());
		if (!result.ok) return refused(result, 'delete');
		redirect(303, '/people?status=deleted');
	},

	restore: async (event) => {
		const { user, employee } = await target(event);
		const form = await readFormBody(event.request);
		const expected = await expectedOf(form);
		if (expected === null) return fail(400, { section: 'delete', errors: { form: CHANGED } });
		const result = await restore(event.locals.db, user.id, employee.id, expected, now());
		if (result.ok) return { section: 'delete', saved: 'Employee restored.' };
		return refused(result, 'delete');
	}
};
