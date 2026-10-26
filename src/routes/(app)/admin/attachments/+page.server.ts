import { fail } from '@sveltejs/kit';
import {
	countPurgeable,
	PURGE_AFTER_DAYS,
	purgeDeletedParents
} from '#lib/server/attachments/purge';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { requireAdmin } from '#lib/server/guards';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/** RB-04 retention (admin only): purge files of tasks, pages and projects deleted 30 or more days ago. */
export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	return { purgeable: await countPurgeable(event.locals.db, now()), days: PURGE_AFTER_DAYS };
};

export const actions: Actions = {
	purge: async (event) => {
		requireAdmin(event);
		const form = await readFormBody(event.request);
		if (textField(form, 'confirm') !== 'yes')
			return fail(400, { purgeError: 'Tick the box to confirm.' });
		const result = await purgeDeletedParents(event.locals.db, getEnv().FILES, now());
		return { purged: result };
	}
};
