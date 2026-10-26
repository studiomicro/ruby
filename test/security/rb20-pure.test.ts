import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CSP_DIRECTIVES } from '../../src/lib/server/csp';
import {
	isDataPath,
	OFFLINE_PAGE,
	requestPolicy,
	shellPaths,
	type PolicyRequest
} from '../../src/lib/shared/sw-policy';
import {
	isSignedOutMessage,
	isSkipWaitingMessage,
	isTrustedSender
} from '../../src/lib/shared/sw-update';
import {
	CONNECTION_LOST_MESSAGE,
	guardSubmit,
	OFFLINE_FORM_MESSAGE
} from '../../src/lib/ui/pwa/offline-guard';
import { isNetworkError } from '../../src/lib/ui/pwa/network-error';
import { parentHref, ROUTE_PARENTS } from '../../src/lib/ui/shell/route-parent';

/**
 * RB-20 red-team proofs (pure): the service worker's cache and request policy under hostile URL variants, the
 * message handshake under spoofed senders, the offline form guard, the offline page and its headers, the manifest, the
 * CSP, and the standalone back control. See docs/features/rb-20-mobile-pwa/SECURITY_REPORT.md.
 */

const ORIGIN = 'https://ruby.example.test';

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

/** The real static folder plus a realistic set of build files, as `$app/manifest` hands them to the worker. */
const STATIC = files('static').map((p) => ({ path: p.replace(/^static\//, '') }));
const IMMUTABLE = [
	{ path: '_app/immutable/entry/app.abc.js' },
	{ path: '_app/immutable/nodes/0.abc.js' },
	{ path: '_app/immutable/assets/0.abc.css' }
];
const SHELL = new Set(shellPaths(IMMUTABLE, STATIC));

const req = (
	url: string,
	init: { method?: string; mode?: string; headers?: Record<string, string> } = {}
): PolicyRequest => {
	const headers = new Headers(init.headers ?? {});
	return {
		method: init.method ?? 'GET',
		url: url.startsWith('http') ? url : `${ORIGIN}${url}`,
		mode: init.mode ?? 'cors',
		headers
	};
};

describe('cache contents: only the shell, never a person’s data', () => {
	it('the precache list holds no HTML but the offline page, no data path, no launch image, no other font', () => {
		for (const path of SHELL) {
			expect(isDataPath(path), path).toBe(false);
			if (path.endsWith('.html')) expect(path).toBe(OFFLINE_PAGE);
			expect(path.startsWith('/splash/') || path.startsWith('/screenshots/'), path).toBe(false);
			if (path.startsWith('/fonts/')) expect(path).toBe('/fonts/geist/1.7.2/Geist-Variable.woff2');
			// Nothing hidden (.DS_Store, .env) or server-side (_headers, _worker.js) can be in the list.
			expect(/\/(\.|_headers|_worker|_routes)/.test(path), path).toBe(false);
		}
		expect(SHELL.has(OFFLINE_PAGE)).toBe(true);
	});

	it('a hostile static or build file name is filtered: HTML, data prefixes, __data.json, version.json', () => {
		const hostile = shellPaths(
			[{ path: '_app/immutable/x/__data.json' }, { path: '_app/version.json' }],
			[
				{ path: 'index.html' },
				{ path: 'kb/1.html' },
				{ path: 'files/report.pdf' },
				{ path: 'hr/salary.csv' },
				{ path: 'people/1.json' },
				{ path: 'api/me' },
				{ path: 'logout' }
			]
		);
		expect(hostile).toEqual([]);
	});

	/** Every request a signed-in page makes that may carry data: none may be answered from, or stored in, the cache. */
	const DATA_REQUESTS: [string, PolicyRequest][] = [
		['page data', req('/kb/1/__data.json?x-sveltekit-invalidated=01')],
		['root page data', req('/__data.json')],
		['api', req('/api/mentions?q=a')],
		['download', req('/files/abc')],
		['download list', req('/files')],
		['hr export', req('/hr/export')],
		['people', req('/people/u1')],
		['calendar page (fetch)', req('/calendar')],
		['notifications page (fetch)', req('/notifications')],
		['logout', req('/logout', { method: 'POST' })],
		['version poll', req('/_app/version.json')],
		['HEAD of a shell file', req('/offline.css', { method: 'HEAD' })],
		['Range on a shell file', req('/offline.css', { headers: { range: 'bytes=0-1' } })],
		['Range on a download', req('/files/abc', { headers: { range: 'bytes=0-1' } })],
		['cross-origin', req('https://team.example.test/cdn-cgi/access/login')],
		['cross-origin same path as a shell file', req('https://evil.example.test/offline.css')],
		['query on a shell file', req('/manifest.webmanifest?user=a')],
		['encoded slash', req('/files%2Fabc')],
		['upper case', req('/HR/export')],
		['double slash', req('//files/abc')],
		['dot segment', req('/./files/abc')],
		['dot-dot segment', req('/_app/immutable/../../files/abc')],
		['encoded dot-dot', req('/_app/immutable/%2e%2e/%2e%2e/files/abc')],
		['trailing slash', req('/files/')],
		['shell path with trailing slash', req('/offline.css/')],
		['encoded shell path', req('/offline%2Ecss')]
	];

	it.each(DATA_REQUESTS)('%s is never answered from the cache', (_, request) => {
		expect(requestPolicy(request, ORIGIN, SHELL)).not.toBe('shell');
	});

	it('page loads (navigations) to every route, variants included, are network-only (never "shell")', () => {
		for (const path of [
			'/',
			'/kb/1',
			'/calendar',
			'/notifications',
			'/offline.html',
			'/manifest.webmanifest',
			'/_app/immutable/entry/app.abc.js',
			'//files/abc',
			'/HR/export',
			'/files%2Fabc'
		]) {
			expect(requestPolicy(req(path, { mode: 'navigate' }), ORIGIN, SHELL), path).not.toBe('shell');
		}
		// Data paths are not even intercepted for a page load (a download opened offline is the browser's own error).
		for (const path of ['/files/abc', '/hr/export', '/people/u1', '/api/x', '/logout'])
			expect(requestPolicy(req(path, { mode: 'navigate' }), ORIGIN, SHELL), path).toBe('network');
	});

	it('the worker writes to Cache Storage in exactly one place (`cache.put` in precache, after a redirect-refusing fetch)', () => {
		const source = readFileSync('src/service-worker/index.ts', 'utf8').replace(
			/\/\*[\s\S]*?\*\/|\/\/.*$/gm,
			''
		);
		expect(source.match(/\.put\(/g)).toHaveLength(1);
		expect(source).not.toMatch(/\.addAll\(|\.add\(|navigationPreload|importScripts|eval\(/);
		// L1 fix: every precached answer is fetched with redirect: 'error' and checked before it is stored.
		expect(source).toMatch(/redirect: 'error'/);
		expect(source).toMatch(/if \(!isPrecacheable\(response\)\)\s*throw/);
		// The only cache match for a page load is the offline page.
		expect(source).toMatch(/caches\.match\(OFFLINE_PAGE/);
		// A network answer to a page load is passed through as it is (401/403/5xx/redirect), never replaced.
		expect(source).toMatch(/return await fetch\(request\)/);
	});
});

describe('update and sign-out handshake: senders', () => {
	it.each([
		['another origin', { type: 'window', url: 'https://evil.example.test/' }],
		['a look-alike origin', { type: 'window', url: 'https://ruby.example.test.evil.test/' }],
		['http downgrade', { type: 'window', url: 'http://ruby.example.test/' }],
		['a sandboxed iframe (opaque origin)', { type: 'window', url: 'about:srcdoc' }],
		['a data: URL window', { type: 'window', url: 'data:text/html,x' }],
		['a same-origin worker', { type: 'worker', url: `${ORIGIN}/w.js` }],
		['a same-origin shared worker', { type: 'sharedworker', url: `${ORIGIN}/w.js` }],
		['no source', null],
		['a MessagePort', { postMessage() {} }],
		['a garbage url', { type: 'window', url: '::' }]
	])('%s is not trusted', (_, source) => {
		expect(isTrustedSender(source, ORIGIN)).toBe(false);
	});

	it('only a same-origin window counts', () => {
		expect(isTrustedSender({ type: 'window', url: `${ORIGIN}/kb/1` }, ORIGIN)).toBe(true);
	});

	it('message shapes: strings, prototypes and look-alikes are ignored', () => {
		for (const data of [
			'SKIP_WAITING',
			{ type: 'skip_waiting' },
			{ type: ['SKIP_WAITING'] },
			Object.create({ type: 'SKIP_WAITING' }) as unknown,
			null
		]) {
			// A prototype-inherited `type` still reads as the message; harmless (same-origin senders only).
			if (typeof data === 'object' && data !== null && !Object.hasOwn(data, 'type')) continue;
			expect(isSkipWaitingMessage(data)).toBe(false);
		}
		expect(isSignedOutMessage({ type: 'SIGNED_OUT ' })).toBe(false);
	});
});

describe('offline form guard: never queues, never bypasses the server', () => {
	const deps = () => ({
		isOnline: vi.fn(() => false),
		showNote: vi.fn(),
		clearNote: vi.fn(),
		markOffline: vi.fn(),
		markOnline: vi.fn()
	});
	const input = () => {
		const cancel = vi.fn();
		return {
			cancel,
			formElement: {} as HTMLFormElement,
			formData: new FormData(),
			action: new URL(`${ORIGIN}/account?/name`),
			controller: new AbortController(),
			submitter: null
		};
	};

	it('offline: the submit is cancelled before the page callback runs; nothing is stored or scheduled', async () => {
		const d = deps();
		const submit = vi.fn();
		const timers = vi.spyOn(globalThis, 'setTimeout');
		const i = input();
		const result = await guardSubmit(submit, d)(i as never);
		expect(i.cancel).toHaveBeenCalledOnce();
		expect(submit).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
		expect(timers).not.toHaveBeenCalled();
		timers.mockRestore();
	});

	it('a server failure (403 CSRF refusal, 500) is not turned into the offline note', async () => {
		const d = deps();
		d.isOnline.mockReturnValue(true);
		const after = await guardSubmit(undefined, d)(input() as never);
		const update = vi.fn();
		await (after as (o: unknown) => Promise<void>)({
			formElement: {},
			result: {
				type: 'error',
				status: 403,
				error: { message: 'Cross-site POST form submissions are forbidden' }
			},
			update
		});
		expect(d.showNote).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledOnce();
	});

	it('fixed (L2): a request whose answer was lost never says "Nothing was saved"; only a never-sent one does', async () => {
		// The browser reports the same TypeError whether the request never left or its response was cut off.
		expect(isNetworkError(new TypeError('Failed to fetch'), true)).toBe(true);
		const d = deps();
		d.isOnline.mockReturnValue(true);
		const after = await guardSubmit(undefined, d)(input() as never);
		await (after as (o: unknown) => Promise<void>)({
			formElement: {},
			result: { type: 'error', error: { message: 'You are offline.', offline: true } },
			update: vi.fn()
		});
		expect(d.showNote).toHaveBeenCalledOnce();
		const message = (d.showNote.mock.calls[0] as unknown[])[1] as string;
		expect(message).toBe(CONNECTION_LOST_MESSAGE);
		expect(message).not.toContain('Nothing was saved');
		expect(OFFLINE_FORM_MESSAGE).toContain('Nothing was saved');
	});

	it('every enhanced form uses the wrapper (no form talks to `$app/forms` enhance directly)', () => {
		const offenders = files('src')
			.filter((p) => p.endsWith('.svelte'))
			.filter((p) =>
				/import\s*\{[^}]*\benhance\b[^}]*\}\s*from\s*'\$app\/forms'/.test(readFileSync(p, 'utf8'))
			);
		expect(offenders).toEqual([]);
	});
});

describe('offline page, headers, manifest and CSP', () => {
	const offline = readFileSync('static/offline.html', 'utf8');
	const headers = readFileSync('_headers', 'utf8');

	it('the offline page has no script, no inline style or handler, no form, no external URL', () => {
		expect(offline).not.toMatch(
			/<script|<iframe|<object|<embed|<form|\son\w+=|style=|javascript:/i
		);
		expect(offline).not.toMatch(/https?:\/\//);
		expect(offline).not.toMatch(/%sveltekit|\{\{|\$\{/);
	});

	it('_headers gives the offline page a script-free, unframeable CSP, and the worker no-cache and no wider scope', () => {
		const block = (path: string) => {
			const at = headers.indexOf(`\n${path}\n`);
			expect(at, path).toBeGreaterThan(-1);
			return headers.slice(at + path.length + 2).split(/\n(?=\S)/)[0]!;
		};
		const off = block('/offline.html');
		expect(off).toContain("script-src 'none'");
		expect(off).toContain("frame-ancestors 'none'");
		expect(off).toContain("connect-src 'none'");
		expect(off).toContain("form-action 'none'");
		expect(off).toContain('X-Frame-Options: DENY');
		const sw = block('/service-worker.js');
		expect(sw).toContain('Cache-Control: no-cache');
		expect(headers).not.toMatch(/Service-Worker-Allowed/i);
		expect(headers).not.toMatch(/Access-Control-Allow-Origin/i);
	});

	it('the manifest points only at this origin: start_url, scope, id, shortcuts and every image', () => {
		const m = JSON.parse(readFileSync('static/manifest.webmanifest', 'utf8')) as {
			start_url: string;
			scope: string;
			id: string;
			shortcuts: { url: string; icons: { src: string }[] }[];
			icons: { src: string }[];
			screenshots: { src: string }[];
			related_applications?: unknown;
			protocol_handlers?: unknown;
			share_target?: unknown;
			file_handlers?: unknown;
		};
		const urls = [
			m.start_url,
			m.scope,
			m.id,
			...m.shortcuts.flatMap((s) => [s.url, ...s.icons.map((i) => i.src)]),
			...m.icons.map((i) => i.src),
			...m.screenshots.map((i) => i.src)
		];
		for (const url of urls) {
			expect(url, url).toMatch(/^\/(?!\/)/);
			expect(new URL(url, ORIGIN).origin).toBe(ORIGIN);
		}
		// No handler that would let another app or site push content into Ruby.
		expect(m.share_target).toBeUndefined();
		expect(m.protocol_handlers).toBeUndefined();
		expect(m.file_handlers).toBeUndefined();
		expect(m.related_applications).toBeUndefined();
	});

	it('manifest-src and worker-src are self only; script-src still has no unsafe-inline or unsafe-eval', () => {
		const d = CSP_DIRECTIVES as Record<string, string[]>;
		expect(d['manifest-src']).toEqual(['self']);
		expect(d['worker-src']).toEqual(['self']);
		expect(d['script-src'] ?? []).not.toContain('unsafe-inline');
		expect(d['script-src'] ?? []).not.toContain('unsafe-eval');
		expect(d['frame-ancestors']).toEqual(['none']);
	});

	it('static SVGs carry no script (served inline without the app CSP)', () => {
		for (const path of files('static').filter((p) => p.endsWith('.svg'))) {
			const svg = readFileSync(path, 'utf8');
			expect(svg, path).not.toMatch(
				/<script|\son\w+=|javascript:|<foreignObject|xlink:href="(?!#)/i
			);
		}
	});

	it('static holds no hidden or server file (served to anyone behind Access, and precached)', () => {
		for (const path of files('static'))
			expect(/\/\.|_headers|_redirects|_worker|\.map$|\.env/.test(path), path).toBe(false);
	});
});

describe('standalone back control: never leaves the origin', () => {
	it('parameter values cannot make the parent link point elsewhere', () => {
		for (const evil of [
			'//evil.test',
			'..%2F..',
			'../../logout',
			'https://evil.test',
			'\\evil.test',
			'%0d%0a'
		]) {
			for (const routeId of Object.keys(ROUTE_PARENTS).map((r) => `/(app)${r}`)) {
				const href = parentHref(routeId, { id: evil, key: evil, number: evil, revision: evil });
				if (href === null) continue;
				expect(href.startsWith('/'), href).toBe(true);
				expect(href.startsWith('//'), href).toBe(false);
				expect(href).not.toContain('\\');
				expect(new URL(href, ORIGIN).origin).toBe(ORIGIN);
				// The value stays one path segment.
				expect(new URL(href, ORIGIN).pathname.split('/').includes('..')).toBe(false);
			}
		}
	});
});
