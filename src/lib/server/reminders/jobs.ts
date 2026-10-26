import { DAY_MS, utcToZoned } from '../../shared/calendar';
import { dispatchDue, type DispatchReport, type EmailSender } from './dispatch';

/**
 * One run of the `ruby-jobs` Worker (workers/jobs/src/index.ts), once a minute: deliver due reminders, write the
 * heartbeat `/reminders` reads, and once a day (03:15 team time) purge old closed reminders. Raw D1 only, no app-only
 * imports.
 */

/** The bindings the jobs Worker has (workers/jobs/wrangler.jsonc). */
export interface JobsEnv {
	DB: D1Database;
	TEAM_TIME_ZONE?: string;
	/** The verified sender address; empty means e-mail is off (owner answer O5). */
	REMINDER_EMAIL_FROM?: string;
	/** The app's host (rendered from RUBY_APP_HOST at deploy) for links in reminder e-mail. */
	APP_HOST?: string;
	/** Cloudflare Email Sending (`send_email` binding). */
	EMAIL?: { send: EmailSender['send'] };
}

/** `app_meta` key of the last finished run's time (UTC ms, as text). */
export const HEARTBEAT_KEY = 'jobs_last_run';
/** `/reminders` warns when the last run is older than this. */
export const HEARTBEAT_STALE_MS = 10 * 60_000;
export const PURGE_TIME = '03:15';
export const PURGE_AFTER_MS = 90 * DAY_MS;
export const PURGE_MAX = 500;

/** The e-mail sender, or null while `REMINDER_EMAIL_FROM` is empty or the binding is missing (in-app goes on). */
export function emailSender(env: JobsEnv): EmailSender | null {
	const from = env.REMINDER_EMAIL_FROM?.trim();
	if (!from || !env.EMAIL) return null;
	const binding = env.EMAIL;
	const host = env.APP_HOST?.trim().toLowerCase() ?? '';
	const origin =
		/^[a-z0-9.-]+\.[a-z]{2,63}$/.test(host) && !host.endsWith('.example.invalid')
			? `https://${host}`
			: null;
	return { from, origin, send: (message) => binding.send(message) };
}

/**
 * Deletes up to PURGE_MAX reminders closed (or deleted) more than 90 days before `now` (O12), sent ones included. A
 * sent reminder's notification stays (notifications are history): its `reminder_id` is cleared in the same batch,
 * before the reminder row goes. The ids are chosen once and bound as JSON.
 */
export async function purgeClosed(db: D1Database, now: number): Promise<number> {
	const cut = now - PURGE_AFTER_MS;
	const { results } = await db
		.prepare(
			`SELECT id FROM reminders
			 WHERE (done_at IS NOT NULL AND done_at < ?1) OR (deleted_at IS NOT NULL AND deleted_at < ?1)
			 ORDER BY id LIMIT ?2`
		)
		.bind(cut, PURGE_MAX)
		.all<{ id: string }>();
	if (results.length === 0) return 0;
	const ids = JSON.stringify(results.map((r) => r.id));
	const closed = `id IN (SELECT value FROM json_each(?1))
		AND ((done_at IS NOT NULL AND done_at < ?2) OR (deleted_at IS NOT NULL AND deleted_at < ?2))`;
	const [, deleted] = await db.batch([
		db
			.prepare(
				`UPDATE notifications SET reminder_id = NULL
				 WHERE reminder_id IN (SELECT id FROM reminders WHERE ${closed})`
			)
			.bind(ids, cut),
		db.prepare(`DELETE FROM reminders WHERE ${closed}`).bind(ids, cut)
	]);
	return deleted?.meta.changes ?? 0;
}

export async function writeHeartbeat(db: D1Database, now: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_meta (key, value, updated_at) VALUES (?1, ?2, ?3)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(HEARTBEAT_KEY, String(now), now)
		.run();
}

export type JobsReport = DispatchReport & { purged: number };

export async function runJobs(
	env: JobsEnv,
	now: number,
	clock: () => number = Date.now
): Promise<JobsReport> {
	const zone = env.TEAM_TIME_ZONE || 'UTC';
	const report = await dispatchDue(env.DB, now, { zone, email: emailSender(env), clock });
	await writeHeartbeat(env.DB, now);
	const purged = utcToZoned(now, zone).time === PURGE_TIME ? await purgeClosed(env.DB, now) : 0;
	// Counts only: never a title, summary or address.
	console.log('jobs_run', { ...report, purged });
	return { ...report, purged };
}
