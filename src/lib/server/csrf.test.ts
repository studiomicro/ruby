import { describe, expect, it } from 'vitest';
import { crossSiteRefusal, isCrossSiteForm } from './csrf';

const SELF = 'https://ruby.example.com';
const req = (method: string, headers: Record<string, string> = {}) =>
	new Request(`${SELF}/x`, { method, headers });

describe('cross-site form check (SvelteKit’s rule, applied in hooks.server.ts)', () => {
	it('refuses form-type or type-less mutating requests from another or no origin', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
			for (const type of [
				undefined,
				'application/x-www-form-urlencoded',
				'multipart/form-data; boundary=x',
				'TEXT/PLAIN;charset=utf-8',
				'application/x-sveltekit-formdata'
			])
				for (const origin of [
					undefined,
					'https://evil.example',
					'null',
					'http://ruby.example.com'
				]) {
					const headers: Record<string, string> = {};
					if (type) headers['content-type'] = type;
					if (origin) headers.origin = origin;
					expect(isCrossSiteForm(req(method, headers), SELF), `${method} ${type} ${origin}`).toBe(
						true
					);
				}
	});

	it('lets same-origin forms, reads and JSON requests through (as SvelteKit does)', () => {
		expect(
			isCrossSiteForm(req('POST', { origin: SELF, 'content-type': 'multipart/form-data' }), SELF)
		).toBe(false);
		expect(isCrossSiteForm(req('GET'), SELF)).toBe(false);
		expect(isCrossSiteForm(req('HEAD'), SELF)).toBe(false);
		expect(isCrossSiteForm(req('POST', { 'content-type': 'application/json' }), SELF)).toBe(false);
	});

	it('answers with SvelteKit’s own body', async () => {
		const text = crossSiteRefusal(req('DELETE'));
		expect(text.status).toBe(403);
		expect(await text.text()).toBe('Cross-site DELETE form submissions are forbidden');
		const json = crossSiteRefusal(req('POST', { accept: 'application/json' }));
		expect(await json.json()).toEqual({
			message: 'Cross-site POST form submissions are forbidden'
		});
	});
});
