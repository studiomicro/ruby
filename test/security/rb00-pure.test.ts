import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	clearAccessKeyCache,
	JWKS_FAILURE_BACKOFF_MS,
	JWKS_REFETCH_MIN_MS,
	verifyAccessJwt
} from '#lib/server/auth/access';
import { isCrossSiteForm } from '#lib/server/csrf';
import { safeReturnTo } from '#lib/server/return-to';
import { renderMarkdown } from '#lib/shared/markdown';

/**
 * Red-team probes for RB-00 (docs/features/rb-00-foundation/SECURITY_REPORT.md): Markdown XSS vectors, the
 * return-to helper, CSRF edge cases and Access JWT verification (alg confusion, JWKS fetch behaviour). Pure: no D1.
 * The report's PROOF tests now assert the fixed behaviour (L1, L6 of fix cycle 1).
 */

describe('Markdown XSS vectors render inert', () => {
	const vectors = [
		'<script>alert(1)</script>',
		'<img src=x onerror=alert(1)>',
		'<svg/onload=alert(1)>',
		'<a href="javascript:alert(1)">x</a>',
		'[x](javascript:alert(1))',
		'[x](JaVaScRiPt:alert(1))',
		'[x](  javascript:alert(1)  )',
		'[x](&#106;avascript:alert(1))',
		'[x](&#x6A;avascript:alert(1))',
		'[x](javascript&colon;alert(1))',
		'[x](java\u0000script:alert(1))',
		'[x](java%09script:alert(1))',
		'[x](%6Aavascript:alert(1))',
		'[x](<javascript:alert(1)>)',
		'[x](vbscript:msgbox(1))',
		'[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
		'[x](DATA:text/html,<script>alert(1)</script>)',
		'[x](file:///etc/passwd)',
		'[x](//evil.test)',
		'[x](\\\\evil.test)',
		'[x](/\\evil.test)',
		'![x](javascript:alert(1))',
		'![x](data:image/svg+xml,<svg onload=alert(1)>)',
		'[ref]\n\n[ref]: javascript:alert(1)',
		'[ref]\n\n[ref]: <data:text/html,x>',
		'<javascript:alert(1)>',
		'<vbscript:alert(1)>',
		'javascript:alert(1)',
		'[x](javascript:alert(1) "title")',
		'[x](https://ok.test" onmouseover="alert(1))',
		'[x](https://ok.test"onmouseover=alert(1)//)',
		'[a](https://ok.test)<b onclick=alert(1)>b</b>',
		'@[<img src=x onerror=alert(1)>](user:00000000-0000-4000-8000-000000000001)',
		'@["><svg onload=alert(1)>](user:00000000-0000-4000-8000-000000000001)',
		'[x](user:00000000-0000-4000-8000-000000000001)',
		'`<script>alert(1)</script>`',
		'```html\n<script>alert(1)</script>\n```',
		'> <iframe src=javascript:alert(1)>',
		'| a |\n|---|\n| <img src=x onerror=alert(1)> |',
		'[x]( javascript:alert(1))',
		'[x]( javascript:alert(1))',
		'[x](java​script:alert(1))'
	];

	it.each(vectors)('%s', (source) => {
		const html = renderMarkdown(source);
		// No live element other than markdown-it's own fixed set; no event handler attribute; no dangerous scheme in
		// any href/src.
		expect(html).not.toMatch(/<(script|img[^>]*onerror|svg|iframe|object|embed|b )/i);
		expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
		for (const m of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
			const url = (m[1] ?? '').replace(/&amp;/g, '&');
			expect(url).not.toMatch(/^\s*(javascript|vbscript|data|file):/i);
			expect(url).not.toMatch(/^\/\//);
		}
	});

	it('table alignment emits a style attribute (blocked by style-src-attr; functional only)', () => {
		expect(renderMarkdown('| a |\n|:-:|\n| b |')).toMatch(/style="text-align:center"/);
	});

	it('with names, a mention shows the real name, never the typed label (L6)', () => {
		const intern = '00000000-0000-4000-8000-000000000002';
		const names = new Map([[intern, 'Ivo <Intern>']]);
		const html = renderMarkdown(`@[Ada Admin](user:${intern.toUpperCase()})`, names);
		expect(html).toContain('<span class="mention">@Ivo &lt;Intern&gt;</span>');
		expect(html).not.toContain('Ada Admin');
		expect(
			renderMarkdown('@[Ada Admin](user:00000000-0000-4000-8000-000000000003)', names)
		).toContain('<span class="mention">@unknown user</span>');
		// Without names (the editor's preview) the typed label is shown, escaped.
		expect(renderMarkdown(`@[Ada Admin](user:${intern})`)).toContain(
			'<span class="mention">@Ada Admin</span>'
		);
	});

	it('pathological inputs at the 200 000-char cap render fast', () => {
		const inputs = [
			'['.repeat(200_000),
			'*a'.repeat(100_000),
			'_'.repeat(200_000),
			'`'.repeat(200_000),
			'> '.repeat(100_000) + 'x',
			'- '.repeat(100_000) + 'x',
			'[a]('.repeat(50_000),
			'<'.repeat(200_000),
			'![['.repeat(66_000),
			'a@b.c '.repeat(33_000),
			'www.a.test/'.repeat(18_000),
			'|a'.repeat(100_000) + '\n' + '|-'.repeat(100_000)
		];
		const timings: Record<number, number> = {};
		inputs.forEach((input, i) => {
			const start = performance.now();
			renderMarkdown(input);
			timings[i] = Math.round(performance.now() - start);
		});
		console.info('markdown timings (ms)', timings);
		// A loose bound (a catastrophic backtrack takes minutes); a loaded machine running the suite in parallel
		// once took 2.6 s on one input.
		for (const ms of Object.values(timings)) expect(ms).toBeLessThan(10_000);
	});
});

describe('safeReturnTo refuses off-site targets', () => {
	const offsite = [
		'//evil.test',
		'///evil.test',
		'/\\evil.test',
		'\\\\evil.test',
		'/\t/evil.test',
		'/\n/evil.test',
		'/%2F/evil.test',
		'/%252F%252Fevil.test',
		'/%5Cevil.test',
		'/%09/evil.test',
		'/.//evil.test',
		'/./%2fevil.test',
		'/a/../..//evil.test',
		'https://evil.test',
		'javascript:alert(1)',
		' /evil',
		'%2F%2Fevil.test',
		'/%25252F%25252Fevil.test',
		'/　/evil.test'
	];
	it.each(offsite)('%s', (value) => {
		const out = safeReturnTo(value);
		expect(out.startsWith('/')).toBe(true);
		expect(out.startsWith('//')).toBe(false);
		expect(new URL(out, 'https://ruby.example.com').origin).toBe('https://ruby.example.com');
		expect(out).not.toMatch(/[\r\n\t\\]/);
	});
});

describe('CSRF hook check', () => {
	const self = 'https://ruby.example.com';
	const req = (headers: Record<string, string>, method = 'POST') =>
		new Request(`${self}/admin/users?/setRole`, { method, headers });
	it('refuses form types from another or no origin, any case or parameters', () => {
		expect(
			isCrossSiteForm(
				req({ 'content-type': 'TEXT/PLAIN;charset=x', origin: 'https://evil.test' }),
				self
			)
		).toBe(true);
		expect(isCrossSiteForm(req({ 'content-type': 'multipart/form-data; boundary=x' }), self)).toBe(
			true
		);
		expect(isCrossSiteForm(req({ origin: 'null' }), self)).toBe(true);
		expect(
			isCrossSiteForm(
				req({
					origin: 'https://evil.example.com',
					'content-type': 'application/x-www-form-urlencoded'
				}),
				self
			)
		).toBe(true);
		expect(
			isCrossSiteForm(
				req({
					origin: 'http://ruby.example.com',
					'content-type': 'application/x-www-form-urlencoded'
				}),
				self
			)
		).toBe(true);
	});
	it('a JSON body passes the hook (needs a CORS preflight; readFormBody answers 415)', () => {
		expect(
			isCrossSiteForm(
				req({ origin: 'https://evil.test', 'content-type': 'application/json' }),
				self
			)
		).toBe(false);
	});
});

describe('Access JWT', () => {
	const TEAM = 'ruby-team.cloudflareaccess.com';
	const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
	const CONFIG = { teamDomain: TEAM, aud: AUD };
	const NOW = 1_800_000_000_000;
	const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
	const enc = new TextEncoder();
	const b64url = (b: Uint8Array | ArrayBuffer) =>
		Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64url');
	const part = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));
	const claims = { aud: [AUD], iss: `https://${TEAM}`, exp: NOW / 1000 + 600 };
	let pair: CryptoKeyPair;
	let jwk: JsonWebKey;

	beforeAll(async () => {
		pair = (await crypto.subtle.generateKey(
			{ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
			true,
			['sign', 'verify']
		)) as CryptoKeyPair;
		jwk = {
			...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
			kid: 'k1',
			alg: 'RS256'
		} as JsonWebKey;
	});
	afterEach(() => clearAccessKeyCache());

	const jwksFetch = () => vi.fn(async () => Response.json({ keys: [jwk] }));

	it('refuses alg none, HS256 keyed with the public key, and a stripped signature', async () => {
		const fetchFn = jwksFetch();
		const none = `${part({ alg: 'none', kid: 'k1' })}.${part(claims)}.`;
		expect(await verifyAccessJwt(none, CONFIG, NOW, fetchFn)).toEqual({
			ok: false,
			reason: 'algorithm'
		});
		const noneSig = `${part({ alg: 'none', kid: 'k1' })}.${part(claims)}.AA`;
		expect((await verifyAccessJwt(noneSig, CONFIG, NOW, fetchFn)).ok).toBe(false);
		const hsKey = await crypto.subtle.importKey(
			'raw',
			enc.encode(JSON.stringify(jwk)),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const hsSigned = `${part({ alg: 'HS256', kid: 'k1' })}.${part(claims)}`;
		const hsSig = await crypto.subtle.sign('HMAC', hsKey, enc.encode(hsSigned));
		expect(await verifyAccessJwt(`${hsSigned}.${b64url(hsSig)}`, CONFIG, NOW, fetchFn)).toEqual({
			ok: false,
			reason: 'algorithm'
		});
		const rsSigned = `${part({ alg: 'RS256', kid: 'k1' })}.${part(claims)}`;
		expect(await verifyAccessJwt(`${rsSigned}.`, CONFIG, NOW, fetchFn)).toEqual({
			ok: false,
			reason: 'signature'
		});
	});

	it('concurrent unknown-kid requests share one JWKS fetch (single flight, L1)', async () => {
		const fetchFn = jwksFetch();
		const good = `${part({ alg: 'RS256', kid: 'k1' })}.${part(claims)}`;
		const sig = await crypto.subtle.sign(RS256, pair.privateKey, enc.encode(good));
		expect((await verifyAccessJwt(`${good}.${b64url(sig)}`, CONFIG, NOW, fetchFn)).ok).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const later = NOW + JWKS_REFETCH_MIN_MS + 1;
		const forged = Array.from(
			{ length: 25 },
			(_, i) => `${part({ alg: 'RS256', kid: `fake-${i}` })}.${part(claims)}.AAAA`
		);
		const verdicts = await Promise.all(
			forged.map((t) => verifyAccessJwt(t, CONFIG, later, fetchFn))
		);
		expect(verdicts.every((v) => !v.ok && v.reason === 'unknown_key')).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('concurrent cold requests share one fetch, and all of them verify', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const fetchFn = vi.fn(async () => {
			await gate;
			return Response.json({ keys: [jwk] });
		});
		const good = `${part({ alg: 'RS256', kid: 'k1' })}.${part(claims)}`;
		const sig = await crypto.subtle.sign(RS256, pair.privateKey, enc.encode(good));
		const pending = Array.from({ length: 20 }, () =>
			verifyAccessJwt(`${good}.${b64url(sig)}`, CONFIG, NOW, fetchFn)
		);
		release();
		expect((await Promise.all(pending)).every((v) => v.ok)).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('after a failed fetch, requests within JWKS_FAILURE_BACKOFF_MS do not fetch again (L1)', async () => {
		const failing = vi.fn(async () => new Response('down', { status: 502 }));
		const t = `${part({ alg: 'RS256', kid: 'k1' })}.${part(claims)}.AAAA`;
		const unavailable = { ok: false, reason: 'jwks_unavailable' };
		await Promise.all(
			Array.from({ length: 10 }, async () =>
				expect(await verifyAccessJwt(t, CONFIG, NOW, failing)).toEqual(unavailable)
			)
		);
		for (let i = 0; i < 10; i++)
			expect(await verifyAccessJwt(t, CONFIG, NOW + i * 1000, failing)).toEqual(unavailable);
		expect(failing).toHaveBeenCalledTimes(1);
		// Once the back-off is over, the next request tries again, and a recovered endpoint is used.
		const good = `${part({ alg: 'RS256', kid: 'k1' })}.${part(claims)}`;
		const sig = await crypto.subtle.sign(RS256, pair.privateKey, enc.encode(good));
		const recovered = jwksFetch();
		const after = NOW + JWKS_FAILURE_BACKOFF_MS;
		expect((await verifyAccessJwt(`${good}.${b64url(sig)}`, CONFIG, after, recovered)).ok).toBe(
			true
		);
		expect(recovered).toHaveBeenCalledTimes(1);
	});

	it('a JWKS fetch that never settles stops being shared once stale (re-check N1)', async () => {
		const hung = vi.fn(() => new Promise<Response>(() => {}));
		const good = `${part({ alg: 'RS256', kid: 'k1' })}.${part(claims)}`;
		const sig = await crypto.subtle.sign(RS256, pair.privateKey, enc.encode(good));
		const token = `${good}.${b64url(sig)}`;
		// Never awaited: this request hangs with its fetch.
		void verifyAccessJwt(token, CONFIG, NOW, hung);
		await Promise.resolve();
		expect(hung).toHaveBeenCalledTimes(1);
		const working = jwksFetch();
		// Within the fetch timeout the hung flight is still shared: no second fetch.
		void verifyAccessJwt(token, CONFIG, NOW + 1_000, working);
		await Promise.resolve();
		expect(working).not.toHaveBeenCalled();
		// Past timeout + 1 s a new fetch replaces it and the request verifies.
		expect((await verifyAccessJwt(token, CONFIG, NOW + 6_001, working)).ok).toBe(true);
		expect(working).toHaveBeenCalledTimes(1);
	});
});
