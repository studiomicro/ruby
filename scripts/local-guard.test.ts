import { describe, expect, it } from 'vitest';
import { assertLocalOnly, LOCAL_STATE_DIR, localStateDir } from './local-guard';

describe('assertLocalOnly', () => {
	it('allows plain local runs', () => {
		expect(() => assertLocalOnly([])).not.toThrow();
		expect(() => assertLocalOnly(['--verbose'])).not.toThrow();
	});
	it.each([
		['--remote'],
		['--env', 'production'],
		['--env=production'],
		['-e', 'production'],
		['-e=production'],
		['--preview']
	])('refuses %s', (...args) => {
		expect(() => assertLocalOnly(args)).toThrow(/Refusing/);
	});
});

describe('localStateDir', () => {
	it('defaults to .wrangler/state and accepts a sibling folder', () => {
		expect(localStateDir({})).toBe(LOCAL_STATE_DIR);
		expect(localStateDir({ RUBY_PERSIST_TO: '.wrangler/e2e-state' })).toBe('.wrangler/e2e-state');
	});
	it.each(['/', '..', '.wrangler/../src', '.wrangler', 'state', '.wrangler/a/b', '/tmp/x'])(
		'refuses %s',
		(dir) => expect(() => localStateDir({ RUBY_PERSIST_TO: dir })).toThrow(/Refusing/)
	);
});
