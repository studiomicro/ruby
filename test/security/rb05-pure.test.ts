import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	CLIENT_MAX_ATTEMPTS,
	THROTTLE_MAX_ATTEMPTS,
	THROTTLE_MINUTE_MS,
	THROTTLE_SCOPES,
	THROTTLE_WINDOW_MS
} from '#lib/server/auth/throttle';
import {
	decodeKeySecret,
	decryptField,
	encryptField,
	generateKeySecret,
	HrCryptoError,
	loadKey
} from '#lib/server/hr/crypto';
import { csvCell } from '#lib/server/hr/export';
import { buildOrgTree, ORG_DEPTH_MAX, type OrgInput, type OrgNode } from '#lib/server/hr/org';

/**
 * RB-05 red team, cycle 1: pure checks of the field crypto, the CSV cell guard, the org tree and the RB-00 throttle
 * budgets after the rebase. Keys are generated per run, never a real one.
 */

const b64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

describe('field crypto (AES-256-GCM)', () => {
	it('a fresh 96-bit IV per value: 2000 encryptions of one value never repeat an IV', async () => {
		const key = (await loadKey(generateKeySecret()))!;
		const ivs = new Set<string>();
		const cts = new Set<string>();
		for (let i = 0; i < 2000; i++) {
			const token = await encryptField(key, 'row', 'nik', '3171098765432109');
			const [prefix, iv, ct] = token.split('.');
			expect(prefix).toBe('v1');
			expect(atob(iv!.replace(/-/g, '+').replace(/_/g, '/')).length).toBe(12);
			ivs.add(iv!);
			cts.add(ct!);
		}
		expect(ivs.size).toBe(2000);
		expect(cts.size).toBe(2000);
	});

	it('AAD binds row and field; tampering, truncation, re-prefixing and a wrong key all fail closed', async () => {
		const secret = generateKeySecret();
		const key = (await loadKey(secret))!;
		const other = (await loadKey(generateKeySecret()))!;
		const token = await encryptField(key, 'emp-a', 'nik', 'VALUE-1234');
		expect(await decryptField(key, 'emp-a', 'nik', token)).toBe('VALUE-1234');
		const [, iv, ct] = token.split('.') as [string, string, string];
		const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
		const bad = [
			() => decryptField(key, 'emp-b', 'nik', token),
			() => decryptField(key, 'emp-a', 'npwp', token),
			// The separator cannot be shifted: `emp|a` + `nik` vs `emp` + `a|nik`.
			() => decryptField(key, 'emp-a|nik', '', token),
			() => decryptField(other, 'emp-a', 'nik', token),
			() => decryptField(key, 'emp-a', 'nik', `v1.${iv}.${flip(ct)}`),
			() => decryptField(key, 'emp-a', 'nik', `v1.${flip(iv)}.${ct}`),
			() => decryptField(key, 'emp-a', 'nik', `v1.${iv}.${ct.slice(0, -4)}`),
			() => decryptField(key, 'emp-a', 'nik', `v2.${iv}.${ct}`),
			() => decryptField(key, 'emp-a', 'nik', `v1.${iv}.${ct}.x`),
			() => decryptField(key, 'emp-a', 'nik', `v1.${iv}`),
			() => decryptField(key, 'emp-a', 'nik', `v1.${b64url(new Uint8Array(16))}.${ct}`),
			() => decryptField(key, 'emp-a', 'nik', 'VALUE-1234'),
			() => decryptField(key, 'emp-a', 'nik', '')
		];
		for (const attempt of bad) {
			const err = await attempt().then(
				() => null,
				(e: unknown) => e
			);
			expect(err).toBeInstanceOf(HrCryptoError);
			expect(String((err as Error).message)).not.toContain('VALUE');
			expect(JSON.stringify(err)).not.toContain(secret);
		}
	});

	it('the key must be exactly 32 bytes of base64/base64url; anything else is "not configured"', async () => {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		const std = btoa(String.fromCharCode(...bytes));
		expect(decodeKeySecret(std)).toEqual(bytes);
		expect(decodeKeySecret(b64url(bytes))).toEqual(bytes);
		expect(decodeKeySecret(` ${b64url(bytes)}\n`)).toEqual(bytes);
		for (const bad of [
			undefined,
			null,
			'',
			'   ',
			b64url(bytes.slice(0, 31)),
			b64url(new Uint8Array([...bytes, 1])),
			b64url(bytes.slice(0, 16)),
			`${b64url(bytes)}!`,
			'0'.repeat(64),
			'a'.repeat(43) + '=====',
			Buffer.from(bytes).toString('hex')
		]) {
			expect(decodeKeySecret(bad as string), String(bad)).toBeNull();
			expect(await loadKey(bad as string)).toBeNull();
		}
	});

	it('the CryptoKey is not extractable; no HR module logs or serialises key material', async () => {
		const key = (await loadKey(generateKeySecret()))!;
		expect(key.extractable).toBe(false);
		await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
		for (const file of [
			'src/lib/server/hr/crypto.ts',
			'src/lib/server/hr/access.ts',
			'src/lib/server/hr/reveal.ts'
		]) {
			const text = readFileSync(file, 'utf8');
			expect(text).not.toMatch(/console\.[a-z]+\([^)]*(HR_DATA_KEY|secret|raw\b|key\b)/i);
		}
	});
});

describe('CSV cell guard', () => {
	it('every formula trigger is prefixed, quotes are doubled, the cell is always quoted', () => {
		for (const v of ['=1+1', '+1', '-1', '@A1', '\t=1', '\r=1', '=HYPERLINK("x")', '-', '=']) {
			const cell = csvCell(v);
			expect(cell.startsWith(`"'`), JSON.stringify(v)).toBe(true);
			expect(cell.endsWith('"')).toBe(true);
		}
		expect(csvCell('a"b')).toBe('"a""b"');
		expect(csvCell('"=1"')).toBe('"""=1"""');
		expect(csvCell('Plain')).toBe('"Plain"');
		expect(csvCell(null)).toBe('""');
		// A line break inside a value stays inside the quoted cell.
		expect(csvCell('a\r\n=1')).toBe('"a\r\n=1"');
	});
});

describe('org tree', () => {
	const count = (nodes: OrgNode[]): number => nodes.reduce((n, x) => n + 1 + count(x.children), 0);

	it('cycles, self-loops and a 1000-deep chain terminate, each employee shown once', () => {
		const rows: OrgInput[] = [];
		for (let i = 0; i < 1000; i++)
			rows.push({
				id: `e${i}`,
				fullName: `<script>alert(${i})</script>`,
				preferredName: null,
				jobTitle: null,
				managerId: i === 0 ? 'e999' : `e${i - 1}`
			});
		rows.push({
			id: 'self',
			fullName: 'S',
			preferredName: null,
			jobTitle: null,
			managerId: 'self'
		});
		const started = Date.now();
		const tree = buildOrgTree(rows);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(count(tree)).toBe(rows.length);
		const depth = (n: OrgNode): number => 1 + Math.max(0, ...n.children.map(depth));
		expect(Math.max(...tree.map(depth))).toBeLessThanOrEqual(ORG_DEPTH_MAX);
	});
});

describe('rebase merge of throttle.ts', () => {
	it('RB-00 budgets unchanged; the RB-00 and RB-05 scopes are all present', () => {
		expect(THROTTLE_WINDOW_MS).toBe(10 * 60 * 1000);
		expect(THROTTLE_MINUTE_MS).toBe(60 * 1000);
		expect(THROTTLE_MAX_ATTEMPTS).toBe(20);
		expect(CLIENT_MAX_ATTEMPTS).toBe(100);
		// Later features add scopes of their own (the full list is pinned in throttle.test.ts).
		expect([...THROTTLE_SCOPES]).toEqual(
			expect.arrayContaining([
				'sign-in',
				'setup',
				'invite-accept',
				'account-password',
				'upload',
				'comment-create',
				'search',
				'mention-search',
				'hr-reveal',
				'hr-export'
			])
		);
	});
});
