import type { Db } from '../db';
import { getEnv } from '../env';

/**
 * E-mail reminders (owner answer O5): opt-in per user, offered only while the app's `REMINDER_EMAIL_FROM` var names a
 * sender (the jobs Worker reads its own copy of the var before it sends).
 */
export const emailRemindersConfigured = (): boolean => !!getEnv().REMINDER_EMAIL_FROM?.trim();

export async function emailRemindersOn(db: Db, userId: string): Promise<boolean> {
	const row = await db.$client
		.prepare(`SELECT email_reminders AS on_ FROM user_calendar_prefs WHERE user_id = ?1`)
		.bind(userId)
		.first<{ on_: number }>();
	return row?.on_ === 1;
}

export async function setEmailReminders(db: Db, userId: string, on: boolean, at: number) {
	await db.$client
		.prepare(
			`INSERT INTO user_calendar_prefs (user_id, email_reminders, updated_at) VALUES (?1, ?2, ?3)
			 ON CONFLICT (user_id) DO UPDATE SET email_reminders = excluded.email_reminders, updated_at = excluded.updated_at`
		)
		.bind(userId, on ? 1 : 0, at)
		.run();
}
