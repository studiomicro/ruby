/**
 * The "Install Ruby" row's decisions (RB-20), pure so they are unit-tested (install-state.test.ts). Browser wiring in
 * install.svelte.ts. The row is passive: no prompt on load, no banner, no reminder.
 */

/** localStorage key: when the person last dismissed the browser's install dialog (UTC ms). Holds no user data. */
export const DISMISS_KEY = 'ruby.install.dismissed';
/** A dismissal hides the install button for this long. */
export const DISMISS_MS = 30 * 24 * 60 * 60_000;

export type InstallRow =
	/** Running as the installed app, or just installed: no button. */
	| 'installed'
	/** Chromium offered its install dialog: the button opens it. */
	| 'prompt'
	/** The browser's dialog was dismissed in the last 30 days: no button. */
	| 'dismissed'
	/** iOS Safari: the button opens the "Add to Home Screen" steps. */
	| 'ios-steps'
	/** An iOS in-app browser (Instagram, Gmail …): install only works from Safari. */
	| 'ios-open-in-safari'
	/** No install path this browser offers. */
	| 'unavailable';

export function installRow(input: {
	standalone: boolean;
	installed: boolean;
	hasPrompt: boolean;
	dismissed: boolean;
	/** `'standalone' in navigator`: iOS and iPadOS (feature detection first). */
	iosLike: boolean;
	userAgent: string;
}): InstallRow {
	if (input.standalone || input.installed) return 'installed';
	if (input.dismissed) return 'dismissed';
	if (input.hasPrompt) return 'prompt';
	if (input.iosLike) return isIosSafari(input.userAgent) ? 'ios-steps' : 'ios-open-in-safari';
	return 'unavailable';
}

/**
 * Safari itself rather than another browser or an app's built-in browser. Only chooses the wording; the install path
 * is decided by feature detection. In-app browsers drop the `Safari/` token or add their own.
 */
export function isIosSafari(ua: string): boolean {
	const head = ua.slice(0, 1024);
	return (
		/\bSafari\//.test(head) &&
		!/\b(CriOS|FxiOS|EdgiOS|OPiOS|GSA|FBAN|FBAV|Instagram|LinkedInApp|Line|Twitter)\b/.test(head)
	);
}

/** Minimal storage: `localStorage`, or a fake in tests. Every call may throw (private mode, blocked storage). */
export interface KeyStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** True while a dismissal from the last 30 days is stored. A throwing or empty store means "not dismissed". */
export function isDismissed(store: () => KeyStore, now: number): boolean {
	try {
		const at = Number(store().getItem(DISMISS_KEY));
		return Number.isFinite(at) && at > 0 && now - at < DISMISS_MS;
	} catch {
		return false;
	}
}

/** Remembers a dismissal; a throwing store only loses the memory. */
export function rememberDismissal(store: () => KeyStore, now: number): void {
	try {
		store().setItem(DISMISS_KEY, String(now));
	} catch {
		// Storage blocked: the button is back on the next load, nothing else changes.
	}
}
