import {
	COMPENSATION_SECRET_FIELDS,
	CONTACT_SECRET_FIELDS,
	SENSITIVE_FIELDS,
	type RevealField
} from '#lib/shared/enums';
import type { Db } from '../db';
import { errorLabel } from '../util';
import { writeAudit } from './audit';
import { decryptField } from './crypto';
import { secretOf } from './repo';
import type { Access } from './visibility';

/**
 * The reveal flow (PRD › Reveal flow): one field of one employee, decrypted only after its audit row is stored.
 * Every reveal is audited (`sensitive_view`, or `compensation_view` for salary), including one's own; a failing
 * audit insert refuses the reveal and nothing is decrypted. The value is returned to the action only, never logged.
 */

const REVEAL_FIELDS: readonly string[] = [
	...SENSITIVE_FIELDS,
	...CONTACT_SECRET_FIELDS,
	...COMPENSATION_SECRET_FIELDS
];

export const isRevealField = (f: string): f is RevealField => REVEAL_FIELDS.includes(f);

/** The tier a reveal field belongs to: salary is tier 3 (HR only), the rest tier 2 (self and HR). */
export const revealTier = (f: RevealField): 2 | 3 =>
	(COMPENSATION_SECRET_FIELDS as readonly string[]).includes(f) ? 3 : 2;

export const mayReveal = (access: Access, f: RevealField) =>
	revealTier(f) === 3 ? access.tier3 : access.tier2;

export type RevealResult =
	{ ok: true; value: string } | { ok: false; reason: 'empty' | 'audit_failed' | 'decrypt_failed' };

export async function revealField(
	db: Db,
	key: CryptoKey,
	actorId: string,
	employeeId: string,
	field: RevealField,
	ref: string | null,
	now: number
): Promise<RevealResult> {
	const secret = await secretOf(db, employeeId, field, ref);
	if (!secret) return { ok: false, reason: 'empty' };
	try {
		await writeAudit(db, {
			actorId,
			action: revealTier(field) === 3 ? 'compensation_view' : 'sensitive_view',
			employeeId,
			fields: [field],
			at: now
		});
	} catch (e) {
		console.error('hr reveal: audit insert failed', errorLabel(e));
		return { ok: false, reason: 'audit_failed' };
	}
	try {
		return {
			ok: true,
			value: await decryptField(key, secret.rowId, field, secret.token, secret.keyVersion)
		};
	} catch (e) {
		console.error('hr reveal: decrypt failed', errorLabel(e));
		return { ok: false, reason: 'decrypt_failed' };
	}
}

/** A salary amount (minor units as stored) as `Rp 12.500.000`. */
export function formatIdr(minorText: string): string {
	const minor = Number(minorText);
	if (!Number.isSafeInteger(minor)) return 'Unreadable';
	const rupiah = Math.floor(minor / 100);
	return `Rp ${String(rupiah).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}
