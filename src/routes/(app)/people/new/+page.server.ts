import { fail, redirect } from '@sveltejs/kit';
import { readFormBody } from '#lib/server/forms';
import { requireHr } from '#lib/server/hr/access';
import { createEmployee, listActiveEmployees } from '#lib/server/hr/repo';
import { HR_LIMITS, parseWork } from '#lib/server/hr/validation';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/** HR adds an employee record (work and employment fields; sensitive data is added on the edit page). */
export const load: PageServerLoad = async (event) => {
	await requireHr(event);
	const managers = await listActiveEmployees(event.locals.db);
	return {
		managers: managers.map((m) => ({
			id: m.id,
			name: m.jobTitle ? `${m.fullName} — ${m.jobTitle}` : m.fullName
		}))
	};
};

export const actions: Actions = {
	default: async (event) => {
		const { user } = await requireHr(event);
		const form = await readFormBody(event.request, HR_LIMITS.formBodyMax);
		const parsed = parseWork(form);
		if (!parsed.ok) return fail(400, { errors: parsed.errors, values: parsed.echo });
		const result = await createEmployee(event.locals.db, user.id, parsed.value, now());
		if (!result.ok)
			return fail(400, {
				errors: result.reason === 'invalid' ? result.errors : { form: 'Could not create.' },
				values: parsed.value
			});
		redirect(303, `/people/${result.id}?notice=created`);
	}
};
