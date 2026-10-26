import { describe, expect, it } from 'vitest';
import { isProtectedRoute, signInLocation } from './gate';
import { secureDeployment, sessionCookieName } from './session';

describe('isProtectedRoute', () => {
	it.each(['/(app)', '/(app)/account', '/(app)/admin/users', '/(app)/projects/[key]'])(
		'%s needs a session',
		(id) => expect(isProtectedRoute(id)).toBe(true)
	);
	it.each([
		null,
		'/(auth)/login',
		'/(auth)/setup',
		'/(auth)/invite/[token]',
		'/logout',
		'/(application)/x'
	])('%s is public', (id) => expect(isProtectedRoute(id)).toBe(false));
});

describe('signInLocation', () => {
	it('carries the original path and query in next', () => {
		expect(signInLocation(new URL('http://localhost/projects?view=board'))).toBe(
			'/login?next=%2Fprojects%3Fview%3Dboard'
		);
	});
	it('drops SvelteKit data-request params and omits next for /', () => {
		expect(signInLocation(new URL('http://localhost/kb?x-sveltekit-invalidated=01&q=x'))).toBe(
			'/login?next=%2Fkb%3Fq%3Dx'
		);
		expect(signInLocation(new URL('http://localhost/'))).toBe('/login');
	});
});

describe('secure deployment and cookie name', () => {
	it.each(['localhost', 'app.localhost', '127.0.0.1', '[::1]', 'LOCALHOST.'])(
		'%s is local dev',
		(h) => expect(secureDeployment(h)).toBe(false)
	);
	it.each([
		'ruby.example.com',
		'ruby.example.workers.dev',
		'localhost.evil.test',
		'127.0.0.1.nip.io'
	])('%s is a secure deployment', (h) => expect(secureDeployment(h)).toBe(true));
	it('prefixes __Host- only when secure', () => {
		expect(sessionCookieName(true)).toBe('__Host-ruby_session');
		expect(sessionCookieName(false)).toBe('ruby_session');
	});
});
