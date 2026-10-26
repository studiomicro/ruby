import { fail, redirect } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import {
	describeNotifications,
	formatCursor,
	listNotifications,
	markAllRead,
	markRead,
	parseCursor,
	parseFilter
} from '#lib/server/notifications/repo';
import { isUuid } from '#lib/server/tasks/validation';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/** The viewer's inbox: newest 30, `?filter=unread`, `?before=` for older rows. Only their own rows, ever. */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const filter = parseFilter(event.url.searchParams.get('filter'));
	const before = parseCursor(event.url.searchParams.get('before'));
	const db = event.locals.db;
	const { rows, next } = await listNotifications(db, user.id, { filter, before });
	return {
		filter,
		before: before ? formatCursor(before) : null,
		next,
		items: await describeNotifications(db, rows)
	};
};

/**
 * Where a mark-read form goes back to: the list it was sent from, rebuilt from checked values only (filter and
 * cursor), so nothing from the form becomes a redirect target as it is.
 */
function backTo(form: FormData): string {
	const params = new URLSearchParams();
	if (parseFilter(textField(form, 'filter')) === 'unread') params.set('filter', 'unread');
	const before = parseCursor(textField(form, 'before'));
	if (before) params.set('before', formatCursor(before));
	const query = params.toString();
	return `/notifications${query ? `?${query}` : ''}`;
}

export const actions: Actions = {
	/** One of the viewer's own rows; another user's id, a missing or read one, changes nothing (idempotent). */
	read: async (event) => {
		const user = requireUser(event);
		const form = await readFormBody(event.request);
		const id = textField(form, 'id');
		if (!isUuid(id)) return fail(404, { readError: 'Notification not found.' });
		await markRead(event.locals.db, user.id, id.toLowerCase(), now());
		// A fetch from the row's link (mark read, then follow it) needs no page back.
		if (textField(form, 'quiet') === '1') return { read: true };
		redirect(303, backTo(form));
	},

	/** Every unread row of the viewer, in one statement. */
	readAll: async (event) => {
		const user = requireUser(event);
		const form = await readFormBody(event.request);
		await markAllRead(event.locals.db, user.id, now());
		redirect(303, backTo(form));
	}
};
