import { error } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import { requireAdmin } from '#lib/server/guards';
import { pmInvalid, pmOk, pmRefused } from '#lib/server/pm/route';
import {
	createTeamLabel,
	deleteTeamLabel,
	listTeamLabelsQuery,
	teamLabelUsageQuery,
	updateTeamLabel
} from '#lib/server/pm/team-labels';
import {
	expectedField,
	idField,
	parseLabel,
	PM_LIMITS,
	PM_MESSAGES
} from '#lib/server/pm/validation';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/**
 * Team labels (RB-12, admins only; owner decision O1): workspace labels every project can use. Create, rename,
 * recolour and soft-delete; each row shows how many live tasks carry it. One round trip of two statements.
 */
export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const db = event.locals.db;
	const [labels, usage] = await db.batch([listTeamLabelsQuery(db), teamLabelUsageQuery(db)]);
	const used = new Map(usage.map((u) => [u.id, Number(u.n)]));
	return {
		labels: labels.map((l) => ({ ...l, used: used.get(l.id) ?? 0 })),
		max: PM_LIMITS.teamLabelsMax,
		nameMax: PM_LIMITS.labelNameMax
	};
};

const NOT_FOUND = 'Label not found.';

export const actions: Actions = {
	create: async (event) => {
		const user = requireAdmin(event);
		const form = await readFormBody(event.request);
		const values = { name: textField(form, 'name').slice(0, 200), color: textField(form, 'color') };
		const parsed = parseLabel(form);
		if (!parsed.ok)
			return pmInvalid('create', 'Check the label.', { errors: parsed.errors, values });
		const result = await createTeamLabel(event.locals.db, user, parsed.value, now());
		if (result.ok) return pmOk('create', `Team label “${parsed.value.name}” added.`, result.id);
		if (result.reason === 'forbidden') error(403, PM_MESSAGES.notAdmin);
		return pmRefused('create', result, NOT_FOUND, { values });
	},

	update: async (event) => {
		const user = requireAdmin(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) error(404, NOT_FOUND);
		const values = { name: textField(form, 'name').slice(0, 200), color: textField(form, 'color') };
		const expected = expectedField(form);
		if (expected === null) return pmInvalid('row', PM_MESSAGES.stale, { id, values });
		const parsed = parseLabel(form);
		if (!parsed.ok)
			return pmInvalid('row', 'Check the label.', { errors: parsed.errors, id, values });
		const result = await updateTeamLabel(event.locals.db, user, id, parsed.value, expected, now());
		if (result.ok) return pmOk('row', 'Label saved.', id);
		if (result.reason === 'forbidden') error(403, PM_MESSAGES.notAdmin);
		return pmRefused('row', result, NOT_FOUND, { id, values });
	},

	/** Soft delete after the confirmation box ("Used on N tasks"); there is no undo (owner decision O7). */
	delete: async (event) => {
		const user = requireAdmin(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) error(404, NOT_FOUND);
		if (textField(form, 'confirm') !== 'yes')
			return pmInvalid('row', 'Tick the box to confirm.', { id });
		const result = await deleteTeamLabel(event.locals.db, user, id, now());
		if (result.ok) return pmOk('row', 'Label deleted.', id);
		if (result.reason === 'forbidden') error(403, PM_MESSAGES.notAdmin);
		return pmRefused('row', result, NOT_FOUND, { id });
	}
};
