import { error } from '@sveltejs/kit';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { requireHr } from '#lib/server/hr/access';
import { writeAudit } from '#lib/server/hr/audit';
import { buildDirectoryCsv } from '#lib/server/hr/export';
import { listForExport } from '#lib/server/hr/repo';
import { todayIn } from '#lib/server/tasks/dates';
import { getEnv } from '#lib/server/env';
import { errorLabel, now } from '#lib/server/util';
import type { RequestHandler } from './$types';

const EXPORT_MAX = 5;

/**
 * HR's CSV download of the directory (tier 0 and tier 1 only). A POST (the button is a form), so a cross-site
 * request cannot trigger it; throttled (`hr-export`, 5 per 10 minutes) and audited with the row count before any
 * byte is sent: no audit row, no file.
 */
export const POST: RequestHandler = async (event) => {
	const { user } = await requireHr(event);
	const db = event.locals.db;
	const at = now();
	if (await overUserAttemptLimit(db, user.id, at, 'hr-export', EXPORT_MAX))
		error(429, 'Too many exports. Wait a few minutes.');
	const rows = await listForExport(db);
	try {
		await writeAudit(db, { actorId: user.id, action: 'export', detail: `${rows.length} rows`, at });
	} catch (e) {
		console.error('hr export: audit insert failed', errorLabel(e));
		error(503, 'Export is unavailable right now. Try again.');
	}
	return new Response(buildDirectoryCsv(rows), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="people-${todayIn(getEnv().TEAM_TIME_ZONE, at)}.csv"`,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
