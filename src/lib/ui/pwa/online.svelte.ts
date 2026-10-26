/**
 * Whether the device looks online (RB-20), for the offline banner and the offline form guard. `navigator.onLine` and
 * its `online`/`offline` events are a hint only, so a form whose request fails with a network error also marks the
 * state offline until the next request that reaches the server (src/lib/ui/pwa/offline-form.ts). Browser only: the
 * root layout starts watching on mount.
 */
export const connection = $state({ online: true });

/** Starts following the browser's online state; returns the cleanup. */
export function watchConnection(): () => void {
	const update = () => (connection.online = navigator.onLine);
	update();
	addEventListener('online', update);
	addEventListener('offline', update);
	return () => {
		removeEventListener('online', update);
		removeEventListener('offline', update);
	};
}

export const markOffline = () => (connection.online = false);
export const markOnline = () => (connection.online = true);
