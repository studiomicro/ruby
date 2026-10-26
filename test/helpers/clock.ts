import { onTestFinished, vi } from 'vitest';

/**
 * Pins `Date` to just after the start of a throttle window for the rest of the current test, so a test that spends a
 * whole budget never straddles two windows (real-clock tests failed whenever a minute or 10-minute boundary fell
 * inside them). Timers other than `Date` keep running. Restored automatically when the test finishes.
 */
export function pinToWindowStart(windowMs: number): void {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Math.floor(Date.now() / windowMs) * windowMs + 1_000);
	onTestFinished(() => {
		vi.useRealTimers();
	});
}
