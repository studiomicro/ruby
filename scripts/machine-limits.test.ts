import { availableParallelism } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { e2eWorkers, maxLoad, testWorkers, waitForQuiet } from './machine-limits.ts';

describe('machine limits', () => {
	it('defaults to a bounded worker count and honours the overrides', () => {
		const n = testWorkers({});
		expect(n).toBeGreaterThanOrEqual(1);
		expect(n).toBeLessThanOrEqual(4);
		expect(testWorkers({ RUBY_TEST_WORKERS: '7' })).toBe(7);
		expect(testWorkers({ RUBY_TEST_WORKERS: 'many' })).toBe(n);
		expect(e2eWorkers({})).toBe(2);
		expect(e2eWorkers({ RUBY_E2E_WORKERS: '1' })).toBe(1);
		expect(maxLoad({})).toBe(availableParallelism());
		expect(maxLoad({ RUBY_MAX_LOAD: '16' })).toBe(16);
	});

	it('starts at once in CI and when the machine is quiet', async () => {
		const pause = vi.fn(async () => {});
		expect(await waitForQuiet({ CI: 'true' }, () => 999, pause)).toBe(true);
		expect(await waitForQuiet({ RUBY_MAX_LOAD: '10' }, () => 3, pause)).toBe(true);
		expect(pause).not.toHaveBeenCalled();
	});

	it('waits while the load is high, then starts anyway after the limit', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const loads = [20, 15, 4];
		const pause = vi.fn(async () => {});
		expect(await waitForQuiet({ RUBY_MAX_LOAD: '10' }, () => loads.shift() ?? 0, pause)).toBe(true);
		expect(pause).toHaveBeenCalledTimes(2);
		const busy = vi.fn(async () => {});
		const env = { RUBY_MAX_LOAD: '10', RUBY_LOAD_WAIT_S: '30' };
		expect(await waitForQuiet(env, () => 50, busy)).toBe(false);
		expect(busy).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledOnce();
		vi.restoreAllMocks();
	});
});
