/**
 * Test runs sized to the machine they run on (owner request 2026-10-26: "adjust to the machine limit"). A developer
 * machine is often shared with other work: unbounded parallel test workers plus a busy CPU turn timing-sensitive
 * tests (races, throttles, CPU bounds) into false failures. Locally, Vitest and Playwright use a bounded number of
 * workers, and `npm run test` / `npm run test:e2e` first wait until the machine's load drops below its core count.
 * CI (`CI` set) keeps each tool's own defaults and never waits.
 *
 * Overrides: RUBY_TEST_WORKERS (Vitest), RUBY_E2E_WORKERS (Playwright), RUBY_MAX_LOAD (the load to wait for),
 * RUBY_LOAD_WAIT_S (how long to wait at most; then the run starts anyway with a warning).
 */
import { availableParallelism, loadavg } from 'node:os';

/** The variables read here; `process.env` fits it. */
type Env = Record<string, string | undefined>;

const positive = (raw: string | undefined): number | null => {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
};

const cores = () => availableParallelism();

/** Vitest workers: RUBY_TEST_WORKERS, else 40% of the cores (at least 1, at most 4). */
export function testWorkers(env: Env = process.env): number {
	return positive(env.RUBY_TEST_WORKERS) ?? Math.min(4, Math.max(1, Math.floor(cores() * 0.4)));
}

/** Playwright workers: RUBY_E2E_WORKERS, else 2 (each worker drives a browser against one wrangler dev server). */
export function e2eWorkers(env: Env = process.env): number {
	return positive(env.RUBY_E2E_WORKERS) ?? 2;
}

/** The 1-minute load average a local run waits for: RUBY_MAX_LOAD, else the core count. */
export function maxLoad(env: Env = process.env): number {
	return positive(env.RUBY_MAX_LOAD) ?? cores();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the 1-minute load average is below maxLoad(), checking every 15 s, for at most RUBY_LOAD_WAIT_S
 * (default 600 s); returns whether the machine got quiet in time. Returns at once in CI.
 */
export async function waitForQuiet(
	env: Env = process.env,
	read: () => number = () => loadavg()[0] ?? 0,
	pause: (ms: number) => Promise<unknown> = sleep
): Promise<boolean> {
	if (env.CI) return true;
	const limit = maxLoad(env);
	const deadline = (positive(env.RUBY_LOAD_WAIT_S) ?? 600) * 1000;
	let waited = 0;
	for (;;) {
		const load = read();
		if (load < limit) return true;
		if (waited >= deadline) {
			console.warn(
				`machine-limits: load ${load.toFixed(1)} still ≥ ${limit} after ${waited / 1000} s; starting anyway`
			);
			return false;
		}
		if (waited === 0)
			console.log(
				`machine-limits: load ${load.toFixed(1)} ≥ ${limit}; waiting for a quieter machine`
			);
		await pause(15_000);
		waited += 15_000;
	}
}

// `node scripts/machine-limits.ts`: the wait step of the npm test scripts.
if (import.meta.url === `file://${process.argv[1]}`) await waitForQuiet();
