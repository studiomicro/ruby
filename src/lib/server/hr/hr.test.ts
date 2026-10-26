import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tenure } from '#lib/ui/hr/tenure';
import { parseAuditCursor, zoneDayStart } from './audit';
import {
	decodeKeySecret,
	decryptField,
	encryptField,
	generateKeySecret,
	HrCryptoError,
	loadKey
} from './crypto';
import { buildDirectoryCsv, csvCell } from './export';
import { buildOrgTree, ORG_DEPTH_MAX, type OrgInput } from './org';
import type { EmployeeRow } from './repo';
import { formatIdr, isRevealField, mayReveal } from './reveal';
import {
	cleanMultiline,
	identifierDigits,
	parseCompensation,
	parseContact,
	parseDirectoryQuery,
	parsePrivate,
	parseTerminate,
	parseWork,
	PRIVATE_FIELDS
} from './validation';
import { maskLast4, viewerAccess, type EmployeeScope, type Viewer } from './visibility';

const formOf = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
};

describe('field encryption (AES-256-GCM, row and field bound)', () => {
	it('round-trips and uses a fresh IV every time', async () => {
		const key = (await loadKey(generateKeySecret()))!;
		const a = await encryptField(key, 'row-1', 'nik', '3171234567890001');
		const b = await encryptField(key, 'row-1', 'nik', '3171234567890001');
		expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
		expect(a).not.toBe(b);
		expect(a).not.toContain('3171234567890001');
		expect(await decryptField(key, 'row-1', 'nik', a)).toBe('3171234567890001');
	});

	it('refuses another row, another field, another key, tampering and truncation', async () => {
		const secret = generateKeySecret();
		const key = (await loadKey(secret))!;
		const other = (await loadKey(generateKeySecret()))!;
		const token = await encryptField(key, 'row-1', 'nik', 'secret value');
		await expect(decryptField(key, 'row-2', 'nik', token)).rejects.toBeInstanceOf(HrCryptoError);
		await expect(decryptField(key, 'row-1', 'npwp', token)).rejects.toBeInstanceOf(HrCryptoError);
		await expect(decryptField(other, 'row-1', 'nik', token)).rejects.toBeInstanceOf(HrCryptoError);
		// Flip a character inside the ciphertext: the last base64url character may carry only padding bits.
		const at = token.length - 5;
		const flipped = token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1);
		await expect(decryptField(key, 'row-1', 'nik', flipped)).rejects.toThrow();
		await expect(decryptField(key, 'row-1', 'nik', token.slice(0, 20))).rejects.toThrow();
		await expect(decryptField(key, 'row-1', 'nik', 'v2.' + token.slice(3))).rejects.toThrow();
		await expect(decryptField(key, 'row-1', 'nik', 'garbage')).rejects.toThrow();
		const err = await decryptField(key, 'row-2', 'nik', token).catch((e: Error) => e);
		expect(String((err as Error).message)).not.toContain('secret value');
	});

	it('refuses a ciphertext of an unknown key_version', async () => {
		const key = (await loadKey(generateKeySecret()))!;
		const token = await encryptField(key, 'row-1', 'nik', 'value');
		expect(await decryptField(key, 'row-1', 'nik', token, 1)).toBe('value');
		await expect(decryptField(key, 'row-1', 'nik', token, 2)).rejects.toBeInstanceOf(HrCryptoError);
		await expect(decryptField(key, 'row-1', 'nik', token, 0)).rejects.toBeInstanceOf(HrCryptoError);
	});

	it('loads a key only from exactly 32 bytes of base64url or base64', async () => {
		expect(await loadKey(undefined)).toBeNull();
		expect(await loadKey('')).toBeNull();
		expect(await loadKey('not base64 !!')).toBeNull();
		expect(await loadKey(btoa('x'.repeat(31)))).toBeNull();
		expect(await loadKey(btoa('x'.repeat(33)))).toBeNull();
		expect(decodeKeySecret(btoa('x'.repeat(32)))).toHaveLength(32);
		expect(decodeKeySecret(generateKeySecret())).toHaveLength(32);
		expect(await loadKey(btoa('x'.repeat(32)))).not.toBeNull();
	});
});

describe('viewer access (roadmap 4.2)', () => {
	const viewer = (o: Partial<Viewer> = {}): Viewer => ({
		userId: 'u-viewer',
		isHr: false,
		isAdmin: false,
		ownEmployeeId: null,
		...o
	});
	const emp = (o: Partial<EmployeeScope> = {}): EmployeeScope => ({
		id: 'e-1',
		userId: 'u-1',
		managerId: 'e-mgr',
		status: 'active',
		deletedAt: null,
		...o
	});
	const tiers = (a: ReturnType<typeof viewerAccess>) => [a.visible, a.tier1, a.tier2, a.tier3];

	it('gives each viewer exactly its tiers', () => {
		expect(tiers(viewerAccess(viewer(), emp()))).toEqual([true, false, false, false]);
		expect(tiers(viewerAccess(viewer({ isAdmin: true }), emp()))).toEqual([
			true,
			false,
			false,
			false
		]);
		expect(tiers(viewerAccess(viewer({ userId: 'u-1' }), emp()))).toEqual([
			true,
			true,
			true,
			false
		]);
		expect(tiers(viewerAccess(viewer({ ownEmployeeId: 'e-mgr' }), emp()))).toEqual([
			true,
			true,
			false,
			false
		]);
		expect(tiers(viewerAccess(viewer({ isHr: true }), emp()))).toEqual([true, true, true, true]);
	});

	it('hides terminated and deleted employees from everyone but HR', () => {
		for (const e of [emp({ status: 'terminated' }), emp({ deletedAt: 1 })]) {
			expect(viewerAccess(viewer({ userId: 'u-1' }), e).visible).toBe(false);
			expect(viewerAccess(viewer({ ownEmployeeId: 'e-mgr' }), e).visible).toBe(false);
			expect(viewerAccess(viewer({ isHr: true }), e).visible).toBe(true);
		}
	});

	it('salary is tier 3 (HR only); other secrets tier 2', () => {
		const self = viewerAccess(viewer({ userId: 'u-1' }), emp());
		expect(mayReveal(self, 'nik')).toBe(true);
		expect(mayReveal(self, 'contact_phone')).toBe(true);
		expect(mayReveal(self, 'compensation_amount')).toBe(false);
		expect(isRevealField('nik')).toBe(true);
		expect(isRevealField('full_name')).toBe(false);
		expect(isRevealField('__proto__')).toBe(false);
	});

	it('masks with the last four digits only', () => {
		expect(maskLast4('1234')).toBe('•••• 1234');
		expect(maskLast4(null)).toBe('Hidden');
		expect(maskLast4('<b>')).toBe('Hidden');
	});
});

describe('validation boundaries (AC12)', () => {
	const today = '2026-10-26';
	const one = (field: string, value: string) =>
		parsePrivate(formOf({ [field]: value }), PRIVATE_FIELDS, today);

	it('NIK 16 digits only; NPWP 15 or 16; bank account 5..30; BPJS 8..20', () => {
		expect(one('nik', '1'.repeat(15)).ok).toBe(false);
		expect(one('nik', '1'.repeat(17)).ok).toBe(false);
		expect(one('nik', '3171 2345.6789-0001')).toEqual({
			ok: true,
			changes: { nik: '3171234567890001' }
		});
		expect(one('npwp', '1'.repeat(14)).ok).toBe(false);
		expect(one('npwp', '1'.repeat(15)).ok).toBe(true);
		expect(one('npwp', '1'.repeat(16)).ok).toBe(true);
		expect(one('bank_account', '1234').ok).toBe(false);
		expect(one('bank_account', '12345').ok).toBe(true);
		expect(one('bank_account', '1'.repeat(30)).ok).toBe(true);
		expect(one('bank_account', '1'.repeat(31)).ok).toBe(false);
		expect(one('bpjs_kes', '1'.repeat(7)).ok).toBe(false);
		expect(one('bpjs_tk', '1'.repeat(20)).ok).toBe(true);
		expect(identifierDigits('12a45', 1, 9)).toBeNull();
	});

	it('birth date must be real and at least 14 years ago', () => {
		expect(one('birth_date', '2026-02-30').ok).toBe(false);
		expect(one('birth_date', '2012-10-26').ok).toBe(true);
		expect(one('birth_date', '2012-10-27').ok).toBe(false);
		expect(one('birth_date', '1899-12-31').ok).toBe(false);
	});

	it('blank keeps, clear_ removes, unknown fields are ignored', () => {
		expect(parsePrivate(formOf({ nik: '  ' }), PRIVATE_FIELDS, today)).toEqual({
			ok: true,
			changes: {}
		});
		expect(parsePrivate(formOf({ clear_nik: 'on' }), PRIVATE_FIELDS, today)).toEqual({
			ok: true,
			changes: { nik: null }
		});
		expect(
			parsePrivate(
				formOf({ nik: '1'.repeat(16), personal_phone: '0812 3456' }),
				['personal_phone'],
				today
			)
		).toEqual({ ok: true, changes: { personal_phone: '0812 3456' } });
	});

	it('the address keeps line breaks and drops control and invisible characters', () => {
		expect(cleanMultiline('Jl. Contoh 1\r\n​RT 01\u0007\n\n\n\nJakarta', 500).value).toBe(
			'Jl. Contoh 1\nRT 01\n\nJakarta'
		);
		expect(cleanMultiline('x'.repeat(501), 500).tooLong).toBe(true);
	});

	it('work fields: names 1..100, dates real, end after start, enums', () => {
		const base = { fullName: 'Fictional Person', employmentType: 'permanent' };
		expect(parseWork(formOf(base)).ok).toBe(true);
		expect(parseWork(formOf({ ...base, fullName: '' })).ok).toBe(false);
		expect(parseWork(formOf({ ...base, fullName: 'x'.repeat(100) })).ok).toBe(true);
		expect(parseWork(formOf({ ...base, fullName: 'x'.repeat(101) })).ok).toBe(false);
		expect(parseWork(formOf({ ...base, startOn: '2026-02-30' })).ok).toBe(false);
		expect(
			parseWork(formOf({ ...base, startOn: '2026-05-01', probationEndsOn: '2026-04-30' })).ok
		).toBe(false);
		expect(parseWork(formOf({ ...base, employmentType: 'boss' })).ok).toBe(false);
		expect(parseWork(formOf({ ...base, employeeNo: 'A B' })).ok).toBe(false);
		expect(parseWork(formOf({ ...base, managerId: 'not-a-uuid' })).ok).toBe(false);
		expect(parseWork(formOf({ ...base, workPhone: '1234' })).ok).toBe(false);
		expect(parseWork(formOf({ ...base, workEmail: 'a@b' })).ok).toBe(false);
	});

	it('terminate needs a date not before the start and a confirmation', () => {
		expect(parseTerminate(formOf({ endOn: '2026-01-01', confirm: 'on' }), '2025-01-01').ok).toBe(
			true
		);
		expect(parseTerminate(formOf({ endOn: '2024-12-31', confirm: 'on' }), '2025-01-01').ok).toBe(
			false
		);
		expect(parseTerminate(formOf({ endOn: '2026-01-01' }), null).ok).toBe(false);
	});

	it('emergency contacts and salary records', () => {
		const c = {
			contactName: 'Fictional Kin',
			relationship: 'Sibling',
			contactPhone: '+62 811 000'
		};
		expect(parseContact(formOf(c)).ok).toBe(true);
		expect(parseContact(formOf({ ...c, contactName: '' })).ok).toBe(false);
		expect(parseContact(formOf({ ...c, relationship: 'x'.repeat(41) })).ok).toBe(false);
		expect(parseCompensation(formOf({ effectiveOn: '2026-01-01', amount: '12.500.000' }))).toEqual({
			ok: true,
			value: { effectiveOn: '2026-01-01', amountMinor: 1_250_000_000, note: null }
		});
		expect(parseCompensation(formOf({ effectiveOn: '2026-01-01', amount: '0' })).ok).toBe(false);
		expect(parseCompensation(formOf({ effectiveOn: '2026-01-01', amount: '-5' })).ok).toBe(false);
		expect(
			parseCompensation(formOf({ effectiveOn: '2026-01-01', amount: '1'.repeat(13) })).ok
		).toBe(false);
		expect(formatIdr('1250000000')).toBe('Rp 12.500.000');
	});

	it('directory query: q up to 50, status only for HR, page bounds', () => {
		const q = (s: string, hr = false) => parseDirectoryQuery(new URLSearchParams(s), hr);
		expect(q(`q=${'x'.repeat(50)}`)?.q).toHaveLength(50);
		expect(q(`q=${'x'.repeat(51)}`)).toBeNull();
		expect(q('status=terminated')?.status).toBe('active');
		expect(q('status=terminated', true)?.status).toBe('terminated');
		expect(q('status=bogus', true)?.status).toBe('active');
		expect(q('page=0')?.page).toBe(1);
		expect(q('page=99999')?.page).toBe(10_000);
		expect(q('page=abc')?.page).toBe(1);
	});
});

describe('CSV export', () => {
	it('neutralises formula cells and quotes everything', () => {
		for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])
			expect(csvCell(s).startsWith(`"'`)).toBe(true);
		expect(csvCell('Ann "A" Doe')).toBe('"Ann ""A"" Doe"');
		expect(csvCell(null)).toBe('""');
	});
	it('has tier 0 and 1 columns only', () => {
		const csv = buildDirectoryCsv([
			{
				id: 'x',
				fullName: '=HYPERLINK("http://evil.test")',
				employmentType: 'permanent',
				status: 'active'
			} as EmployeeRow
		]);
		const [header, row] = csv.slice(1).split('\r\n');
		expect(header).not.toMatch(/NIK|NPWP|BPJS|bank|salary|address|birth/i);
		expect(row).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
	});
});

describe('org tree', () => {
	const row = (id: string, managerId: string | null): OrgInput => ({
		id,
		fullName: id,
		preferredName: null,
		jobTitle: null,
		managerId
	});

	it('builds a 3-level tree; a missing manager makes a root', () => {
		const tree = buildOrgTree([
			row('ceo', null),
			row('cto', 'ceo'),
			row('dev', 'cto'),
			row('orphan', 'gone')
		]);
		expect(tree.map((n) => n.id)).toEqual(['ceo', 'orphan']);
		expect(tree[0]!.children[0]!.children[0]!.id).toBe('dev');
		expect(tree[0]!.reportCount).toBe(1);
	});

	it('never loops on a cycle and cuts depth', () => {
		const cyc = buildOrgTree([row('a', 'b'), row('b', 'a'), row('c', 'c')]);
		expect(cyc.flatMap((n) => [n.id, ...n.children.map((k) => k.id)]).sort()).toEqual([
			'a',
			'b',
			'c'
		]);
		const chain = Array.from({ length: 15 }, (_, i) => row(`n${i}`, i ? `n${i - 1}` : null));
		let node = buildOrgTree(chain)[0]!;
		let depth = 1;
		while (node.children[0]) {
			node = node.children[0];
			depth++;
		}
		expect(depth).toBe(ORG_DEPTH_MAX);
		expect(node.truncated).toBe(true);
	});
});

describe('dates and cursors', () => {
	it('tenure', () => {
		expect(tenure('2024-07-15', '2026-10-26')).toBe('2 years 3 months');
		expect(tenure('2026-10-01', '2026-10-26')).toBe('0 months');
		expect(tenure('2027-01-01', '2026-10-26')).toBeNull();
	});
	it('a Jakarta day starts at 17:00 UTC the day before', () => {
		expect(new Date(zoneDayStart('2026-10-26', 'Asia/Jakarta')).toISOString()).toBe(
			'2026-10-25T17:00:00.000Z'
		);
		expect(zoneDayStart('2026-10-26', 'Not/AZone')).toBe(Date.UTC(2026, 9, 26));
	});
	it('audit cursor', () => {
		const id = '00000000-0000-4000-8000-000000000001';
		expect(parseAuditCursor(`123_${id}`)).toEqual({ at: 123, id });
		expect(parseAuditCursor('123_x')).toBeNull();
		expect(parseAuditCursor(null)).toBeNull();
	});
});

describe('logging (AC24)', () => {
	it('HR server and route code logs only fixed labels and errorLabel output', () => {
		const files = [
			...readdirSync('src/lib/server/hr').map((f) => `src/lib/server/hr/${f}`),
			...readdirSync('src/routes/(app)', { recursive: true, encoding: 'utf8' })
				.filter((f) => /^(people|hr)\//.test(f))
				.map((f) => `src/routes/(app)/${f}`)
		].filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
		expect(files.length).toBeGreaterThan(8);
		for (const file of files)
			for (const line of readFileSync(file, 'utf8').split('\n'))
				if (line.includes('console.'))
					expect(line.trim(), file).toMatch(/^console\.\w+\('[^']*'(, errorLabel\(e\))?\);$/);
	});
});
