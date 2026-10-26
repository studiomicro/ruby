import { describe, expect, it } from 'vitest';
import {
	CONTROLLER_CHANGE_TIMEOUT_MS,
	isSignedOutMessage,
	isSkipWaitingMessage,
	isTrustedSender,
	offerUpdate,
	shouldCheckForUpdate,
	skipWaitingOnInstall,
	UPDATE_CHECK_GAP_MS,
	waitForControllerChange
} from './sw-update';

const ORIGIN = 'https://ruby.example.test';

describe('worker side', () => {
	it('a first install skips waiting; an update with an active worker waits', () => {
		expect(skipWaitingOnInstall(false)).toBe(true);
		expect(skipWaitingOnInstall(true)).toBe(false);
	});
	it('recognises only the exact messages', () => {
		expect(isSkipWaitingMessage({ type: 'SKIP_WAITING' })).toBe(true);
		expect(isSkipWaitingMessage('SKIP_WAITING')).toBe(false);
		expect(isSkipWaitingMessage(null)).toBe(false);
		expect(isSkipWaitingMessage({ type: 'SIGNED_OUT' })).toBe(false);
		expect(isSignedOutMessage({ type: 'SIGNED_OUT' })).toBe(true);
		expect(isSignedOutMessage({})).toBe(false);
	});
	it('trusts only a window client of this origin', () => {
		expect(isTrustedSender({ type: 'window', url: `${ORIGIN}/projects` }, ORIGIN)).toBe(true);
		expect(isTrustedSender({ type: 'worker', url: `${ORIGIN}/x.js` }, ORIGIN)).toBe(false);
		expect(isTrustedSender({ type: 'window', url: 'https://evil.example.test/' }, ORIGIN)).toBe(
			false
		);
		expect(isTrustedSender({ type: 'window', url: 'not a url' }, ORIGIN)).toBe(false);
		expect(isTrustedSender(null, ORIGIN)).toBe(false);
		expect(isTrustedSender(undefined, ORIGIN)).toBe(false);
	});
});

describe('page side', () => {
	it('offers an installed, waiting update only while another worker is active', () => {
		expect(offerUpdate({ state: 'installed', isWaiting: true, activeWorkerExists: true })).toBe(
			true
		);
		expect(offerUpdate({ state: 'installed', isWaiting: true, activeWorkerExists: false })).toBe(
			false
		);
		expect(offerUpdate({ state: 'installing', isWaiting: false, activeWorkerExists: true })).toBe(
			false
		);
		expect(offerUpdate({ state: 'activated', isWaiting: false, activeWorkerExists: true })).toBe(
			false
		);
	});
	it('checks for an update at most once per five minutes', () => {
		expect(UPDATE_CHECK_GAP_MS).toBe(300_000);
		expect(shouldCheckForUpdate(1_000, null)).toBe(true);
		expect(shouldCheckForUpdate(1_000 + UPDATE_CHECK_GAP_MS - 1, 1_000)).toBe(false);
		expect(shouldCheckForUpdate(1_000 + UPDATE_CHECK_GAP_MS, 1_000)).toBe(true);
	});
});

describe('waitForControllerChange', () => {
	function fakes() {
		const listeners = new Set<() => void>();
		let pending: { fn: () => void; ms: number } | null = null;
		return {
			listeners,
			fire: () => [...listeners].forEach((fn) => fn()),
			fireTimer: () => pending?.fn(),
			timeoutMs: () => pending?.ms,
			events: {
				addEventListener: (_: 'controllerchange', fn: () => void) => void listeners.add(fn),
				removeEventListener: (_: 'controllerchange', fn: () => void) => void listeners.delete(fn)
			},
			timers: {
				set: (fn: () => void, ms: number) => (pending = { fn, ms }),
				clear: () => (pending = null)
			}
		};
	}

	it('resolves on controllerchange and removes its listener', async () => {
		const f = fakes();
		const done = waitForControllerChange(f.events, undefined, f.timers);
		expect(f.timeoutMs()).toBe(CONTROLLER_CHANGE_TIMEOUT_MS);
		f.fire();
		await expect(done).resolves.toBe('changed');
		expect(f.listeners.size).toBe(0);
	});

	it('resolves after the 3 s timeout when no controllerchange comes', async () => {
		const f = fakes();
		const done = waitForControllerChange(f.events, 3_000, f.timers);
		f.fireTimer();
		await expect(done).resolves.toBe('timeout');
		expect(f.listeners.size).toBe(0);
	});
});
