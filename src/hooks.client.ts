import type { HandleClientError } from '@sveltejs/kit/hooks';
import { isNetworkError } from '#lib/ui/pwa/network-error';

/**
 * Unexpected errors in the browser. RB-20: a request that never reached the server (an enhanced form sent while the
 * connection dropped) is marked `offline`, so the form keeps its input and says so instead of showing an error page
 * (src/lib/ui/pwa/offline-guard.ts). Everything else keeps SvelteKit's default message. Nothing is logged here: the
 * error may hold the request's data.
 */
export const handleError: HandleClientError = ({ error }) =>
	isNetworkError(error, navigator.onLine)
		? { message: 'You are offline.', offline: true }
		: { message: 'Internal Error' };
