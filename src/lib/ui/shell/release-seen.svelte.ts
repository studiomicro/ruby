import { LATEST_VERSION } from '#lib/content/releases';
import { hasUnseen } from '#lib/shared/releases';

const KEY = 'ruby.releases.seen';

/** The last version this viewer opened on /releases; localStorage is a per-viewer convenience and may throw. */
function read(): string | null {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

/** Shared by the nav links and the releases page. Starts "seen" so the server render and first paint show no dot. */
const state = $state({ unseen: false });

/** Reads localStorage once the page is in the browser. */
export function refreshUnseen(): void {
	state.unseen = hasUnseen(LATEST_VERSION, read());
}

/** The viewer opened the release notes. */
export function markReleasesSeen(): void {
	try {
		if (LATEST_VERSION) localStorage.setItem(KEY, LATEST_VERSION);
	} catch {
		// Private window or blocked storage: the dot returns on the next visit.
	}
	state.unseen = false;
}

export const releaseDot = {
	get unseen() {
		return state.unseen;
	}
};
