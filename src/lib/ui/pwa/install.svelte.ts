import { installRow, isDismissed, rememberDismissal, type InstallRow } from './install-state';

/**
 * Browser-side install state (RB-20). The root layout starts listening on mount, because Chromium fires
 * `beforeinstallprompt` once, early, on whatever page was opened; the "Install Ruby" rows (InstallEntry.svelte) read
 * it later. The browser's dialog opens only on a tap (`promptInstall`), never by itself.
 */

/** Chromium's install prompt event (not in the DOM typings). */
interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const install = $state<{
	/** False until the root layout has looked at the browser (server render and before hydration). */
	ready: boolean;
	prompt: BeforeInstallPromptEvent | null;
	installed: boolean;
	standalone: boolean;
	dismissed: boolean;
	iosLike: boolean;
	userAgent: string;
	/** The iOS steps dialog (InstallSteps.svelte, one per page in the app layout) is open. */
	stepsOpen: boolean;
}>({
	stepsOpen: false,
	ready: false,
	prompt: null,
	installed: false,
	standalone: false,
	dismissed: false,
	iosLike: false,
	userAgent: ''
});

/** What the row shows now, or null before the browser was looked at. */
export function currentRow(): InstallRow | null {
	if (!install.ready) return null;
	return installRow({
		standalone: install.standalone,
		installed: install.installed,
		hasPrompt: install.prompt !== null,
		dismissed: install.dismissed,
		iosLike: install.iosLike,
		userAgent: install.userAgent
	});
}

/** True when the app runs from the home screen / as an installed app. */
export function isStandalone(): boolean {
	return (
		matchMedia('(display-mode: standalone)').matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

/** Starts capturing `beforeinstallprompt` and `appinstalled`; returns the cleanup. Browser only. */
export function captureInstallPrompt(): () => void {
	const onPrompt = (event: Event) => {
		// Keep the browser's own mini-infobar from showing: the row offers the button instead.
		event.preventDefault();
		install.prompt = event as BeforeInstallPromptEvent;
	};
	const onInstalled = () => {
		install.prompt = null;
		install.installed = true;
	};
	install.standalone = isStandalone();
	install.dismissed = isDismissed(() => localStorage, Date.now());
	install.iosLike = 'standalone' in navigator;
	install.userAgent = navigator.userAgent;
	install.ready = true;
	addEventListener('beforeinstallprompt', onPrompt);
	addEventListener('appinstalled', onInstalled);
	return () => {
		removeEventListener('beforeinstallprompt', onPrompt);
		removeEventListener('appinstalled', onInstalled);
	};
}

/** Opens the browser's install dialog (one tap, one call) and records the answer. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
	const event = install.prompt;
	if (!event) return null;
	// A prompt can be used once: clear it first so a second tap never calls it again.
	install.prompt = null;
	await event.prompt();
	const { outcome } = await event.userChoice;
	if (outcome === 'accepted') install.installed = true;
	else {
		rememberDismissal(() => localStorage, Date.now());
		install.dismissed = true;
	}
	return outcome;
}
