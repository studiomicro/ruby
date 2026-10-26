import { fail, redirect } from '@sveltejs/kit';
import { listActiveUsers } from '#lib/server/auth/users';
import { readFormBody } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { createProject } from '#lib/server/projects/repo';
import { parseProjectCreate } from '#lib/server/projects/validation';
import { LIMITS } from '#lib/server/tasks/validation';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const users = await listActiveUsers(event.locals.db);
	return { users: users.map((u) => ({ id: u.id, name: u.name })), selfId: user.id };
};

export const actions: Actions = {
	/** Any active user may create a project; the key is stored upper case and never changes. */
	default: async (event) => {
		const user = requireUser(event);
		const form = await readFormBody(event.request, LIMITS.formBodyMax);
		const parsed = parseProjectCreate(form);
		if (!parsed.ok) return fail(400, { errors: parsed.errors, values: parsed.echo });
		const created = await createProject(event.locals.db, user, parsed.value, now());
		if (!created.ok)
			return fail(400, {
				errors: created.errors ?? { form: 'The project could not be created.' },
				values: {
					key: parsed.value.key,
					name: parsed.value.name,
					description: parsed.value.description,
					leadId: parsed.value.leadId ?? ''
				}
			});
		redirect(303, `/projects/${parsed.value.key}`);
	}
};
