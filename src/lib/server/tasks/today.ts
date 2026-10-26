import { getEnv } from '../env';
import { now } from '../util';
import { todayIn } from './dates';

/** The team's calendar date right now (TEAM_TIME_ZONE, fallback UTC). */
export function teamToday(at: number = now()): string {
	return todayIn(getEnv().TEAM_TIME_ZONE, at);
}
