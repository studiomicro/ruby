import type { EventTiming } from '../../shared/calendar';
import type { RecFreq } from '../../shared/enums';

/**
 * The `events` columns expansion needs, read with raw SQL as `<alias>.<column> AS <camelCase>` (both Workers use it,
 * so it imports nothing app-only), and the row they give turned into an EventTiming.
 */
export const timingColumns = (a: string) =>
	`${a}.all_day AS allDay, ${a}.start_on AS startOn, ${a}.end_on AS endOn, ${a}.start_at AS startAt,
	 ${a}.end_at AS endAt, ${a}.rec_freq AS recFreq, ${a}.rec_interval AS recInterval, ${a}.rec_until_on AS recUntilOn`;

export interface TimingRow {
	allDay: number | boolean;
	startOn: string | null;
	endOn: string | null;
	startAt: number | null;
	endAt: number | null;
	recFreq: string | null;
	recInterval: number;
	recUntilOn: string | null;
}

export const toTiming = (r: TimingRow): EventTiming => ({
	allDay: Boolean(r.allDay),
	startOn: r.startOn,
	endOn: r.endOn,
	startAt: r.startAt,
	endAt: r.endAt,
	recFreq: (r.recFreq as RecFreq | null) ?? null,
	recInterval: r.recInterval,
	recUntilOn: r.recUntilOn
});

/**
 * SQL: the event `e` (an alias) is visible to the user bound as `userParam` — a team event, or a private one they
 * created or attend (owner answer O2: admin is not an exception). Liveness is checked by the caller.
 */
export const eventVisibleSql = (e: string, userParam: string) =>
	`(${e}.visibility = 'team' OR ${e}.created_by = ${userParam}
	  OR EXISTS (SELECT 1 FROM event_attendees va WHERE va.event_id = ${e}.id AND va.user_id = ${userParam}))`;

/**
 * SQL: event `e` is live: not deleted, its project (if any) not deleted, and — for a private event — its creator
 * still active. A deactivated user's private events count toward nothing and show nowhere (red team L1); an admin
 * can purge them without seeing them (events/purge.ts).
 */
export const eventLiveSql = (e: string) =>
	`(${e}.deleted_at IS NULL AND (${e}.project_id IS NULL
	  OR EXISTS (SELECT 1 FROM projects ep WHERE ep.id = ${e}.project_id AND ep.deleted_at IS NULL))
	  AND (${e}.visibility = 'team'
	  OR EXISTS (SELECT 1 FROM users ec WHERE ec.id = ${e}.created_by AND ec.status = 'active')))`;
