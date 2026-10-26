/**
 * The service worker's update and sign-out handshake (RB-20). Pure, so the decisions are unit-tested like
 * sw-policy.ts; the worker (src/service-worker/index.ts) and the page (src/lib/ui/pwa/register.svelte.ts) both use it.
 *
 * A first install (no active worker yet: nothing open to disrupt) activates at once. An update (an older worker is
 * active) waits in the standard `waiting` state until the person taps Reload on the update banner, which posts
 * SKIP_WAITING; the page reloads once the new worker controls it (or after CONTROLLER_CHANGE_TIMEOUT_MS). Sign-out
 * posts SIGNED_OUT, and the worker deletes every cache: browsers that ignore `Clear-Site-Data` (Safari) still end up
 * with nothing stored. Messages count only from a window of this origin.
 */

/** The message a page posts to the waiting worker to let it take over. */
export const SKIP_WAITING = 'SKIP_WAITING';
/** The message a page posts on sign-out: the worker deletes every cache. */
export const SIGNED_OUT = 'SIGNED_OUT';

/** How long Reload waits for the new worker to take control before it reloads anyway. */
export const CONTROLLER_CHANGE_TIMEOUT_MS = 3_000;
/** At most one `registration.update()` per this gap when the page becomes visible again. */
export const UPDATE_CHECK_GAP_MS = 5 * 60_000;

/** Worker side, on `install`: skip waiting only when no older worker is active (a first install). */
export function skipWaitingOnInstall(activeWorkerExists: boolean): boolean {
	return !activeWorkerExists;
}

const hasType = (data: unknown, type: string) =>
	typeof data === 'object' && data !== null && (data as { type?: unknown }).type === type;

/** Worker side, on `message`: true only for `{ type: 'SKIP_WAITING' }`. */
export const isSkipWaitingMessage = (data: unknown) => hasType(data, SKIP_WAITING);
/** Worker side, on `message`: true only for `{ type: 'SIGNED_OUT' }`. */
export const isSignedOutMessage = (data: unknown) => hasType(data, SIGNED_OUT);

/**
 * Worker side: a message counts only when its sender is a window client of this origin (`event.source` is a
 * `WindowClient`), never another worker, a missing source or another origin.
 */
export function isTrustedSender(source: unknown, origin: string): boolean {
	if (typeof source !== 'object' || source === null) return false;
	const { type, url } = source as { type?: unknown; url?: unknown };
	if (type !== 'window' || typeof url !== 'string') return false;
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

/**
 * Page side: offer the update for a worker that finished installing (`installed`) and sits in this registration's
 * `waiting` slot while another worker is active. Never for a first install, never while it is still installing.
 */
export function offerUpdate(input: {
	state: string;
	isWaiting: boolean;
	activeWorkerExists: boolean;
}): boolean {
	return input.state === 'installed' && input.isWaiting && input.activeWorkerExists;
}

/** Page side: whether becoming visible may start an update check now (at most once per UPDATE_CHECK_GAP_MS). */
export function shouldCheckForUpdate(now: number, lastCheckAt: number | null): boolean {
	return lastCheckAt === null || now - lastCheckAt >= UPDATE_CHECK_GAP_MS;
}

/** Something that fires `controllerchange`: `navigator.serviceWorker`, or a fake in tests. */
export interface ControllerEvents {
	addEventListener(type: 'controllerchange', listener: () => void): void;
	removeEventListener(type: 'controllerchange', listener: () => void): void;
}

/**
 * Resolves on the next `controllerchange`, or after `timeoutMs` when it never comes (another tab took the update,
 * or the browser is slow): Reload must never hang.
 */
export function waitForControllerChange(
	events: ControllerEvents,
	timeoutMs: number = CONTROLLER_CHANGE_TIMEOUT_MS,
	timers: {
		set: (fn: () => void, ms: number) => unknown;
		clear: (id: unknown) => void;
	} = {
		set: (fn, ms) => setTimeout(fn, ms),
		clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)
	}
): Promise<'changed' | 'timeout'> {
	return new Promise((resolve) => {
		const done = (outcome: 'changed' | 'timeout') => {
			events.removeEventListener('controllerchange', onChange);
			timers.clear(timer);
			resolve(outcome);
		};
		const onChange = () => done('changed');
		const timer = timers.set(() => done('timeout'), timeoutMs);
		events.addEventListener('controllerchange', onChange);
	});
}
