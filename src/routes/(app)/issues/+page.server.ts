import { error, fail } from '@sveltejs/kit';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { activeFilterCount, ISSUE_LIMITS, parseIssueParams } from '#lib/server/issues/filters';
import { cleanIssueFilters, issueFilterOptions, listIssues } from '#lib/server/issues/query';
import { BULK_ARCHIVED, issuesBulkUpdate } from '#lib/server/pm/bulk';
import { bulkThrottled } from '#lib/server/pm/bulk-throttle';
import { canonicalizeQuery } from '#lib/server/pm/query';
import { pmInvalid, pmOk, pmRefused } from '#lib/server/pm/route';
import {
	idField,
	ISSUE_BULK_FIELDS,
	parseBulk,
	parseViewName,
	PM_LIMITS,
	PM_MESSAGES
} from '#lib/server/pm/validation';
import { deleteView, saveView } from '#lib/server/pm/views';
import { teamToday } from '#lib/server/tasks/today';
import { errorLabel, now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/**
 * The Issues page (RB-12): every live task of every live project, with filters in the URL (a GET form; works without
 * JavaScript), sort, bounded pages, personal saved views and a capped cross-project bulk edit. Archived projects'
 * tasks only with `archived=1`. Two round trips: the filter options (which also drop ids that no longer exist), then
 * the page with its count and labels.
 */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const db = event.locals.db;
	const parsed = parseIssueParams(event.url.searchParams);
	const options = await issueFilterOptions(db, user.id, parsed.filters);
	const { filters, stale } = cleanIssueFilters(parsed.filters, options);
	let list: Awaited<ReturnType<typeof listIssues>> | null = null;
	try {
		list = await listIssues(
			db,
			filters,
			parsed.sort,
			parsed.page,
			user.id,
			getEnv().TEAM_TIME_ZONE
		);
	} catch (e) {
		// The list failed; the page shows a Retry banner. Ids and classes only, never filter values.
		console.error('issues list failed', errorLabel(e));
	}
	return {
		filters,
		sort: parsed.sort,
		page: parsed.page,
		pageSize: ISSUE_LIMITS.pageSize,
		countCap: ISSUE_LIMITS.countCap,
		ignored: parsed.ignored,
		stale,
		active: activeFilterCount(filters),
		rows: list?.rows ?? [],
		total: list?.total ?? 0,
		loadError: list === null,
		options,
		today: teamToday(),
		viewerId: user.id
	};
};

const VIEW_NOT_FOUND = 'View not found.';

export const actions: Actions = {
	/**
	 * Bulk edit of up to 100 selected issues of any active projects: status, priority, type, assignee, due date, team
	 * label add/remove. All or nothing; milestones and project labels are refused (they belong to one project).
	 */
	bulk: async (event) => {
		const user = requireUser(event);
		const at = now();
		const throttled = await bulkThrottled(event, user, at);
		if (throttled) return throttled;
		const form = await readFormBody(event.request, 32 * 1024);
		const parsed = parseBulk(form, ISSUE_BULK_FIELDS);
		if (!parsed.ok)
			return pmInvalid('bulk', parsed.errors.form ?? 'Check the changes.', {
				errors: parsed.errors as Record<string, string>
			});
		const result = await issuesBulkUpdate(
			event.locals.db,
			user,
			parsed.taskIds,
			parsed.changes,
			at
		);
		if (!result.ok) {
			if (result.reason === 'archived')
				return fail(409, { pm: { section: 'bulk', ok: false, message: BULK_ARCHIVED } });
			return pmRefused('bulk', result, PM_MESSAGES.bulkGone);
		}
		const n = result.updated;
		const capped =
			result.labelCapped > 0
				? ` ${result.labelCapped} already had ${PM_LIMITS.labelsPerTask} labels and did not get the new one.`
				: '';
		const notified =
			result.notifySkipped > 0
				? ` 1 person was notified about the first ${PM_LIMITS.bulkNotifyMax} issues.`
				: '';
		return pmOk('bulk', `${n} ${n === 1 ? 'issue' : 'issues'} updated.${capped}${notified}`);
	},

	/**
	 * Saves the current filters (re-canonicalised from this request's URL query, never posted raw) as a personal
	 * Issues view.
	 */
	saveView: async (event) => {
		const user = requireUser(event);
		const form = await readFormBody(event.request);
		const name = parseViewName(textField(form, 'name'));
		const values = { name: textField(form, 'name').slice(0, 200) };
		if (name.error) return pmInvalid('views', name.error, { errors: { name: name.error }, values });
		const query = canonicalizeQuery('issues', event.url.searchParams);
		if (query === null) return pmInvalid('views', PM_MESSAGES.viewTooLong, { values });
		const result = await saveView(
			event.locals.db,
			user.id,
			null,
			{ name: name.value, kind: 'issues', query },
			now()
		);
		if (result.ok) return pmOk('views', `View “${name.value}” saved.`, result.id);
		return pmRefused('views', result, VIEW_NOT_FOUND, { values });
	},

	/** Deletes one of the user's own Issues views (someone else's id, or a project view's, is not found). */
	deleteView: async (event) => {
		const user = requireUser(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) error(404, VIEW_NOT_FOUND);
		const result = await deleteView(event.locals.db, user.id, null, id, now());
		if (result.ok) return pmOk('views', 'View deleted.');
		return pmRefused('views', result, VIEW_NOT_FOUND);
	}
};
