import {
	offerUpdate,
	shouldCheckForUpdate,
	SIGNED_OUT,
	SKIP_WAITING,
	waitForControllerChange
} from '#lib/shared/sw-update';

/**
 * The service worker's registration on the page side (RB-20). Browser only: the root layout calls
 * `startServiceWorker()` on mount (bundled code, never an inline script, so the CSP needs no change; never under
 * `vite dev`). A newer build that finished installing waits; `pwa.waiting` then shows the update banner
 * (src/lib/ui/shell/UpdateBanner.svelte), whose Reload calls `applyUpdate()`. A page that becomes visible again asks
 * the browser to look for a newer worker, at most once per five minutes, so an installed app resumed from the
 * background notices a deploy.
 */
export const pwa = $state<{
	/** A newer build is installed and waiting for Reload. */
	waiting: boolean;
	/** Reload was tapped: waiting for the new worker to take control. */
	applying: boolean;
}>({ waiting: false, applying: false });

let registration: ServiceWorkerRegistration | null = null;
let lastCheckAt: number | null = null;

function watch(reg: ServiceWorkerRegistration, worker: ServiceWorker): void {
	const decide = () => {
		if (
			offerUpdate({
				state: worker.state,
				isWaiting: reg.waiting === worker,
				activeWorkerExists: reg.active !== null && reg.active !== worker
			})
		)
			pwa.waiting = true;
	};
	decide();
	worker.addEventListener('statechange', decide);
}

/** Registers the worker (when `enabled`) and watches for a waiting update; returns the cleanup. */
export function startServiceWorker(enabled: boolean): () => void {
	if (!enabled || !('serviceWorker' in navigator)) return () => {};
	let stopped = false;
	let reg: ServiceWorkerRegistration | null = null;
	const onUpdateFound = () => {
		if (reg?.installing) watch(reg, reg.installing);
	};
	const onVisible = () => {
		if (document.visibilityState !== 'visible' || !reg) return;
		const now = Date.now();
		if (!shouldCheckForUpdate(now, lastCheckAt)) return;
		lastCheckAt = now;
		reg.update().catch(() => {});
	};
	navigator.serviceWorker
		.register('/service-worker.js', { type: 'module', scope: '/' })
		.then((r) => {
			if (stopped) return;
			reg = r;
			registration = r;
			// Registering is itself a check: the next visible check is five minutes away.
			lastCheckAt = Date.now();
			// An update that finished installing before this page loaded is still waiting: offer it again.
			if (r.waiting) watch(r, r.waiting);
			if (r.installing) watch(r, r.installing);
			r.addEventListener('updatefound', onUpdateFound);
		})
		.catch(() => {
			// No worker (private mode, blocked storage): Ruby works as a plain web page.
		});
	document.addEventListener('visibilitychange', onVisible);
	return () => {
		stopped = true;
		document.removeEventListener('visibilitychange', onVisible);
		reg?.removeEventListener('updatefound', onUpdateFound);
	};
}

/**
 * Reload on the update banner: lets the waiting worker take over, waits for it to control the page (at most three
 * seconds), then loads `href` or reloads. Without a waiting worker (only the server was updated, or another tab
 * applied it meanwhile) it loads at once.
 */
export async function applyUpdate(href: string | null = null): Promise<void> {
	const go = () => (href ? location.assign(href) : location.reload());
	const waiting = registration?.waiting;
	if (!waiting) return go();
	pwa.applying = true;
	const changed = waitForControllerChange(navigator.serviceWorker);
	waiting.postMessage({ type: SKIP_WAITING });
	await changed;
	go();
}

/**
 * Sign-out: tells the worker to delete every cache. `Clear-Site-Data` on the sign-out response does the same where the
 * browser honours it (not Safari). Posted when the sign-out form is sent: the cache holds nothing user-specific, so
 * clearing it even if the request then fails costs nothing but a re-download.
 */
export function signalSignedOut(): void {
	if ('serviceWorker' in navigator)
		navigator.serviceWorker.controller?.postMessage({ type: SIGNED_OUT });
}
