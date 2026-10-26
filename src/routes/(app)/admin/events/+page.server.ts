import { error, fail } from '@sveltejs/kit';
import { purgeCandidates, purgeDeactivatedUserEvents } from '#lib/server/events/purge';
import { readFormBody, textField } from '#lib/server/forms';
import { requireAdmin } from '#lib/server/guards';
import { isUuid } from '#lib/server/tasks/validation';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/** RB-09 (admin only): calendar events left by deactivated users, as counts, and the audited purge. */
export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	return { candidates: await purgeCandidates(event.locals.db) };
};

export const actions: Actions = {
	purge: async (event) => {
		const admin = requireAdmin(event);
		const form = await readFormBody(event.request);
		const userId = textField(form, 'userId');
		if (!isUuid(userId)) error(404, 'User not found.');
		if (textField(form, 'confirm') !== 'yes')
			return fail(400, { purgeError: 'Tick the box to confirm.', userId });
		const removed = await purgeDeactivatedUserEvents(
			event.locals.db,
			admin,
			userId.toLowerCase(),
			now()
		);
		if (removed === 0) return fail(409, { purgeError: 'Nothing to purge for this user.', userId });
		return { purged: removed };
	}
};
