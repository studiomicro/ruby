/**
 * Field encryption for tier 2 and tier 3 HR data (docs/features/rb-05-hrm-roadmap.md section 4.4). AES-256-GCM in
 * the Worker with the secret HR_DATA_KEY (32 random bytes, base64url or base64), a fresh random 96-bit IV per value,
 * and `<row id>|<field>` as associated data, so a ciphertext copied to another row or column no longer decrypts.
 * Stored form: `v1.<iv>.<ciphertext+tag>`, both base64url. Without a usable key nothing is encrypted or decrypted:
 * callers refuse the write (fail closed); there is no plaintext fallback. Errors never carry the value.
 */

/** The key generation every new ciphertext is written with (`key_version` columns). Rotation is not built yet. */
export const KEY_VERSION = 1;
const PREFIX = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** A decryption that failed: wrong key, tampered text or wrong row/field. Never includes the value. */
export class HrCryptoError extends Error {
	constructor() {
		super('HR field could not be decrypted');
		this.name = 'HrCryptoError';
	}
}

function toBase64Url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64 / base64url decoding; null for anything else. */
function fromBase64(text: string): Uint8Array | null {
	if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
	const plain = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
	if (plain.length % 4 === 1) return null;
	try {
		const bin = atob(plain + '='.repeat((4 - (plain.length % 4)) % 4));
		return Uint8Array.from(bin, (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

/** The raw key bytes of an HR_DATA_KEY value, or null when it is missing or not exactly 32 bytes. */
export function decodeKeySecret(secret: string | undefined | null): Uint8Array | null {
	const bytes = fromBase64((secret ?? '').trim());
	return bytes && bytes.length === KEY_BYTES ? bytes : null;
}

let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

/** The AES-GCM key of HR_DATA_KEY, or null when it is unset or malformed ("Not configured"). */
export async function loadKey(secret: string | undefined | null): Promise<CryptoKey | null> {
	const raw = decodeKeySecret(secret);
	if (!raw || !secret) return null;
	if (cached?.secret !== secret)
		cached = {
			secret,
			key: crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
				'encrypt',
				'decrypt'
			])
		};
	return cached.key;
}

const aad = (rowId: string, field: string) => new TextEncoder().encode(`${rowId}|${field}`);

export async function encryptField(
	key: CryptoKey,
	rowId: string,
	field: string,
	plaintext: string
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad(rowId, field) },
		key,
		new TextEncoder().encode(plaintext)
	);
	return `${PREFIX}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

/**
 * The plaintext of `token`; throws HrCryptoError when it is malformed, tampered or bound to another row/field, or
 * when `keyVersion` (the row's `key_version`) names a key generation this Worker does not hold.
 */
export async function decryptField(
	key: CryptoKey,
	rowId: string,
	field: string,
	token: string,
	keyVersion: number = KEY_VERSION
): Promise<string> {
	if (keyVersion !== KEY_VERSION) throw new HrCryptoError();
	const [prefix, ivText, ctText, extra] = token.split('.');
	if (prefix !== PREFIX || extra !== undefined || !ivText || !ctText) throw new HrCryptoError();
	const iv = fromBase64(ivText);
	const ct = fromBase64(ctText);
	if (!iv || iv.length !== IV_BYTES || !ct) throw new HrCryptoError();
	try {
		const plain = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(rowId, field) },
			key,
			ct as BufferSource
		);
		return new TextDecoder().decode(plain);
	} catch {
		throw new HrCryptoError();
	}
}

/** A new random HR_DATA_KEY value (base64url of 32 bytes), for tests and the runbook's one-liner. */
export function generateKeySecret(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}
