import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASES } from '#lib/content/releases';
import {
	appVersionOf,
	compareVersions,
	hasUnseen,
	parseRelease,
	parseReleases,
	releaseAnchor,
	versionProblems
} from './releases';

const file = (version: string, extra = '') =>
	`---\nversion: ${version}\ndate: 2026-10-26\ntitle: T: ${version}\n---\n\n- Note ${version}${extra}\n`;

describe('parseRelease', () => {
	it('reads front matter and body; a title may contain a colon', () => {
		expect(parseRelease(file('0.2.0'))).toEqual({
			version: '0.2.0',
			date: '2026-10-26',
			title: 'T: 0.2.0',
			body: '- Note 0.2.0'
		});
	});
	it('rejects missing front matter, a bad version, a bad date and a missing title', () => {
		expect(() => parseRelease('- hi')).toThrow(/front matter/);
		expect(() => parseRelease(file('0.2'))).toThrow(/bad version/);
		expect(() => parseRelease(file('0.2.0').replace('2026-10-26', '26/10/2026'))).toThrow(
			/bad date/
		);
		expect(() => parseRelease(file('0.2.0').replace('2026-10-26', '2026-13-45'))).toThrow(
			/bad date/
		);
		expect(() => parseRelease('---\nversion: 0.2.0\ndate: 2026-10-26\n---\nx')).toThrow(/title/);
	});
});

describe('parseReleases', () => {
	it('sorts newest first by number, not by text (0.10.0 after 0.9.0)', () => {
		const list = parseReleases({
			'./r/0.9.0.md': file('0.9.0'),
			'./r/0.10.0.md': file('0.10.0'),
			'./r/0.2.1.md': file('0.2.1')
		});
		expect(list.map((r) => r.version)).toEqual(['0.10.0', '0.9.0', '0.2.1']);
	});
	it('rejects a file whose name and version disagree', () => {
		expect(() => parseReleases({ './r/0.3.0.md': file('0.2.0') })).toThrow(/file name/);
	});
});

describe('compareVersions and hasUnseen', () => {
	it('orders versions', () => {
		expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
		expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
		expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
		expect(() => compareVersions('x', '0.1.0')).toThrow();
	});
	it('shows the dot for a never-opened or older seen version only', () => {
		expect(hasUnseen('0.2.0', null)).toBe(true);
		expect(hasUnseen('0.2.0', '0.1.0')).toBe(true);
		expect(hasUnseen('0.2.0', '0.2.0')).toBe(false);
		expect(hasUnseen('0.2.0', '0.3.0')).toBe(false);
		expect(hasUnseen('0.2.0', 'garbage')).toBe(true);
		expect(hasUnseen(undefined, null)).toBe(false);
	});
	it('makes a stable anchor', () => expect(releaseAnchor('0.2.0')).toBe('v0-2-0'));
});

describe('versionProblems', () => {
	const ok = { packageVersion: '0.2.0', appVersion: '0.2.0', latestRelease: '0.2.0' };
	it('accepts agreement', () => expect(versionProblems(ok)).toEqual([]));
	it('names each disagreement', () => {
		expect(versionProblems({ ...ok, appVersion: '0.1.0' })).toEqual([
			expect.stringMatching(/APP_VERSION 0\.1\.0 differs/)
		]);
		expect(versionProblems({ ...ok, latestRelease: '0.1.0' })).toEqual([
			expect.stringMatching(/newest release notes 0\.1\.0/)
		]);
		expect(versionProblems({ ...ok, appVersion: null })).toEqual([
			expect.stringMatching(/no APP_VERSION/)
		]);
		expect(versionProblems({ ...ok, latestRelease: undefined })).toEqual([
			expect.stringMatching(/no release notes/)
		]);
	});
	it('reads APP_VERSION from wrangler text', () => {
		expect(appVersionOf('{ "vars": { "APP_VERSION": "1.2.3" } }')).toBe('1.2.3');
		expect(appVersionOf('{}')).toBeNull();
	});
});

describe('the repository', () => {
	it('package.json, APP_VERSION and the newest release file agree', () => {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
		expect(
			versionProblems({
				packageVersion: pkg.version,
				appVersion: appVersionOf(readFileSync('wrangler.jsonc', 'utf8')),
				latestRelease: RELEASES[0]?.version
			})
		).toEqual([]);
	});
	it('loads the newest release first, ending with 0.1.0, with no internal finding ids in the notes', () => {
		const versions = RELEASES.map((r) => r.version);
		expect(versions.at(-1)).toBe('0.1.0');
		expect(versions).toEqual([...versions].sort((a, b) => compareVersions(b, a)));
		for (const r of RELEASES) expect(r.body).not.toMatch(/\b(RB-\d+|[MLH]\d+|QA|red team)\b/);
	});
});
