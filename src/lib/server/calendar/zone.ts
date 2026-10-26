import { utcToZoned, zoneLabel } from '#lib/shared/calendar';
import { getEnv } from '../env';
import { now } from '../util';

/** TEAM_TIME_ZONE (fallback UTC): events are entered and shown in it (owner decision O8). */
export const teamZone = (): string => getEnv().TEAM_TIME_ZONE || 'UTC';

/** What every calendar and reminder page needs to show times: the zone, its label ("WIB") and today's team date. */
export function zoneContext(at: number = now()) {
	const zone = teamZone();
	return { zone, zoneLabel: zoneLabel(zone), today: utcToZoned(at, zone).date };
}
