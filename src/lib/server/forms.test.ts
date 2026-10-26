import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { checkboxField, FORM_BODY_MAX_BYTES, oneOfField, readFormBody, textField } from './forms';

const post = (body: BodyInit | null, type?: string) =>
	new Request('http://localhost/login', {
		method: 'POST',
		body,
		headers: type ? { 'content-type': type } : {}
	});

async function status(request: Request, max?: number): Promise<number> {
	try {
		await readFormBody(request, max);
		return 200;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

describe('readFormBody', () => {
	const type = 'application/x-www-form-urlencoded';
	it('reads a url-encoded form', async () => {
		const form = await readFormBody(post('email=a%40b.test&password=x&on=on&role=admin', type));
		expect(textField(form, 'email')).toBe('a@b.test');
		expect(textField(form, 'missing')).toBe('');
		expect(textField(form, '__proto__')).toBe('');
		expect(checkboxField(form, 'on')).toBe(true);
		expect(checkboxField(form, 'off')).toBe(false);
		expect(oneOfField(form, 'role', ['admin', 'member'] as const)).toBe('admin');
		expect(oneOfField(form, 'email', ['admin', 'member'] as const)).toBeNull();
	});

	it('answers 415 for JSON, text/plain and no content type', async () => {
		expect(await status(post('{"a":1}', 'application/json'))).toBe(415);
		expect(await status(post('a=1', 'text/plain'))).toBe(415);
		expect(await status(post('a=1'))).toBe(415);
	});

	it('answers 400 for an oversized body, declared or streamed', async () => {
		expect(await status(post(`a=${'x'.repeat(FORM_BODY_MAX_BYTES)}`, type))).toBe(400);
		const stream = new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode(`a=${'x'.repeat(2000)}`));
				c.close();
			}
		});
		const streamed = new Request('http://localhost/x', {
			method: 'POST',
			body: stream,
			headers: { 'content-type': type },
			duplex: 'half'
		} as RequestInit);
		expect(await status(streamed, 1000)).toBe(400);
	});

	it('accepts a larger body when the action names its own bound', async () => {
		expect(await status(post(`a=${'x'.repeat(20_000)}`, type), 64 * 1024)).toBe(200);
	});
});
