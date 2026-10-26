import { describe, expect, it } from 'vitest';
import {
	cacheName,
	isDataPath,
	isPrecacheable,
	isStaleCache,
	OFFLINE_PAGE,
	requestPolicy,
	SHELL_FONT,
	shellPaths
} from './sw-policy';

const ORIGIN = 'https://ruby.example.test';
const IMMUTABLE = [
	{ path: '_app/immutable/entry/start.abc.js' },
	{ path: '_app/immutable/assets/0.css' }
];
const ASSETS = [
	{ path: 'favicon.svg' },
	{ path: 'offline.html' },
	{ path: 'offline.css' },
	{ path: 'manifest.webmanifest' },
	{ path: 'icons/icon-192.png' },
	{ path: 'fonts/geist/1.7.2/Geist-Variable.woff2' },
	{ path: 'fonts/geist/1.7.2/OFL.txt' },
	{ path: 'fonts/geist-mono/1.7.2/GeistMono-Variable.woff2' },
	{ path: 'splash/splash-1206x2622-light.png' },
	{ path: 'screenshots/narrow-home.png' },
	{ path: 'stray.html' }
];
const SHELL = new Set(shellPaths(IMMUTABLE, ASSETS));

const headers = (range = false) => ({ has: (name: string) => range && name === 'range' });
const req = (path: string, init: { method?: string; mode?: string; range?: boolean } = {}) => ({
	method: init.method ?? 'GET',
	url: path.startsWith('http') ? path : `${ORIGIN}${path}`,
	mode: init.mode ?? 'cors',
	headers: headers(init.range)
});
const policy = (path: string, init?: Parameters<typeof req>[1]) =>
	requestPolicy(req(path, init), ORIGIN, SHELL);

describe('shellPaths', () => {
	it('keeps the build, the offline page, icons, the manifest and Geist; nothing else', () => {
		expect([...SHELL].sort()).toEqual(
			[
				'/_app/immutable/entry/start.abc.js',
				'/_app/immutable/assets/0.css',
				'/favicon.svg',
				OFFLINE_PAGE,
				'/offline.css',
				'/manifest.webmanifest',
				'/icons/icon-192.png',
				SHELL_FONT
			].sort()
		);
	});
	it('never keeps a data path, even if one were in the build lists', () => {
		const paths = shellPaths(
			[{ path: 'api/x' }, { path: 'kb/__data.json' }],
			[{ path: 'files/1' }, { path: 'hr/export' }, { path: 'people/1' }]
		);
		expect(paths).toEqual([]);
	});
	it('drops duplicates', () => {
		expect(shellPaths([{ path: '/a.js' }], [{ path: 'a.js' }])).toEqual(['/a.js']);
	});
});

describe('requestPolicy', () => {
	it.each([
		['/_app/immutable/entry/start.abc.js', 'shell'],
		[OFFLINE_PAGE, 'shell'],
		[`${OFFLINE_PAGE}?retry=1`, 'shell'],
		['/icons/icon-192.png', 'shell'],
		[SHELL_FONT, 'shell']
	] as const)('%s is %s', (path, expected) => expect(policy(path)).toBe(expected));

	it('a same-origin page load is navigate', () => {
		expect(policy('/projects', { mode: 'navigate' })).toBe('navigate');
		expect(policy('/', { mode: 'navigate' })).toBe('navigate');
		expect(policy('/kb/abc', { mode: 'navigate' })).toBe('navigate');
	});

	it.each([
		['POST to a page', '/projects', { method: 'POST', mode: 'navigate' }],
		['POST to a shell file', OFFLINE_PAGE, { method: 'POST' }],
		['page data', '/projects/__data.json', {}],
		['root page data', '/__data.json', {}],
		['an API call', '/api/x', {}],
		['a download', '/files/1', {}],
		['a download opened as a page', '/files/1', { mode: 'navigate' }],
		['HR export', '/hr/export', { mode: 'navigate' }],
		['a person', '/people/abc', { mode: 'navigate' }],
		['sign-out', '/logout', { method: 'POST' }],
		['the version poll', '/_app/version.json', {}],
		['a cross-origin request', 'https://elsewhere.example.test/a.js', {}],
		['a cross-origin page', 'https://elsewhere.example.test/', { mode: 'navigate' }],
		['a Range request', '/_app/immutable/entry/start.abc.js', { range: true }],
		['an unknown path', '/whatever.js', {}],
		['a launch image', '/splash/splash-1206x2622-light.png', {}],
		['a screenshot', '/screenshots/narrow-home.png', {}],
		['a shell file with a query', '/icons/icon-192.png?v=2', {}],
		['a non-Geist font', '/fonts/geist-mono/1.7.2/GeistMono-Variable.woff2', {}]
	] as const)('%s is network', (_, path, init) => expect(policy(path, init)).toBe('network'));

	it('no path under a data prefix is ever shell, even if it were in the shell set', () => {
		const shell = new Set(['/api/x', '/files/1', '/hr/export', '/people/1', '/kb/__data.json']);
		const prefixes = ['/api/', '/files/', '/hr/', '/people/'];
		for (const prefix of prefixes)
			for (const tail of ['', 'x', '1', 'a/b', '__data.json', 'x.png'])
				for (const mode of ['cors', 'no-cors', 'same-origin'])
					expect(
						requestPolicy(req(`${prefix}${tail}`, { mode }), ORIGIN, shell),
						`${prefix}${tail}`
					).toBe('network');
		for (const path of ['/kb/__data.json', '/x/y/__data.json'])
			expect(requestPolicy(req(path), ORIGIN, shell)).toBe('network');
	});

	it('isDataPath covers the bare prefixes too', () => {
		for (const path of ['/api', '/files', '/hr', '/people', '/logout'])
			expect(isDataPath(path)).toBe(true);
		expect(isDataPath('/projects')).toBe(false);
	});
});

describe('cache names', () => {
	it('one cache per build; every other name is stale', () => {
		expect(cacheName('123')).toBe('ruby-shell-123');
		expect(isStaleCache('ruby-shell-122', cacheName('123'))).toBe(true);
		expect(isStaleCache('something-else', cacheName('123'))).toBe(true);
		expect(isStaleCache('ruby-shell-123', cacheName('123'))).toBe(false);
	});
});

describe('isPrecacheable', () => {
	it('stores only a plain same-origin 200 that was not redirected', () => {
		expect(isPrecacheable({ ok: true, type: 'basic', redirected: false })).toBe(true);
		expect(isPrecacheable({ ok: true, type: 'basic', redirected: true })).toBe(false);
		expect(isPrecacheable({ ok: false, type: 'basic', redirected: false })).toBe(false);
		expect(isPrecacheable({ ok: false, type: 'opaqueredirect', redirected: false })).toBe(false);
		expect(isPrecacheable({ ok: true, type: 'cors', redirected: false })).toBe(false);
		expect(isPrecacheable({ ok: false, type: 'opaque', redirected: false })).toBe(false);
	});
});
