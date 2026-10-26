import { describe, expect, it } from 'vitest';
import {
	DISMISS_KEY,
	DISMISS_MS,
	installRow,
	isDismissed,
	isIosSafari,
	rememberDismissal,
	type KeyStore
} from './install-state';

const IOS_SAFARI =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const IOS_INSTAGRAM =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0';
const IOS_GMAIL_WEBVIEW =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IOS_CHROME =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1';

const base = {
	standalone: false,
	installed: false,
	hasPrompt: false,
	dismissed: false,
	iosLike: false,
	userAgent: ''
};

describe('installRow', () => {
	it('installed or standalone: no button', () => {
		expect(installRow({ ...base, standalone: true, hasPrompt: true })).toBe('installed');
		expect(installRow({ ...base, installed: true })).toBe('installed');
	});
	it('Chromium with a captured prompt: the button; a recent dismissal hides it', () => {
		expect(installRow({ ...base, hasPrompt: true })).toBe('prompt');
		expect(installRow({ ...base, hasPrompt: true, dismissed: true })).toBe('dismissed');
	});
	it('iOS: steps in Safari, "open in Safari" in other browsers and in-app browsers', () => {
		expect(installRow({ ...base, iosLike: true, userAgent: IOS_SAFARI })).toBe('ios-steps');
		for (const ua of [IOS_INSTAGRAM, IOS_GMAIL_WEBVIEW, IOS_CHROME])
			expect(installRow({ ...base, iosLike: true, userAgent: ua })).toBe('ios-open-in-safari');
	});
	it('no install path: unavailable (the user agent alone never makes it iOS)', () => {
		expect(installRow(base)).toBe('unavailable');
		expect(installRow({ ...base, userAgent: IOS_SAFARI })).toBe('unavailable');
	});
	it('isIosSafari', () => {
		expect(isIosSafari(IOS_SAFARI)).toBe(true);
		expect(isIosSafari(IOS_CHROME)).toBe(false);
	});
});

describe('the 30-day dismissal memory', () => {
	const memory = (): KeyStore & { data: Map<string, string> } => {
		const data = new Map<string, string>();
		return {
			data,
			getItem: (k) => data.get(k) ?? null,
			setItem: (k, v) => void data.set(k, v)
		};
	};
	const throwing = (): KeyStore => {
		throw new Error('blocked');
	};

	it('is remembered for 30 days, then forgotten', () => {
		const store = memory();
		rememberDismissal(() => store, 1_000);
		expect(store.data.get(DISMISS_KEY)).toBe('1000');
		expect(isDismissed(() => store, 1_000 + DISMISS_MS - 1)).toBe(true);
		expect(isDismissed(() => store, 1_000 + DISMISS_MS)).toBe(false);
		expect(DISMISS_MS).toBe(30 * 86_400_000);
	});
	it('a blocked or empty store means "not dismissed", and remembering never throws', () => {
		expect(isDismissed(throwing, 5)).toBe(false);
		expect(() => rememberDismissal(throwing, 5)).not.toThrow();
		expect(isDismissed(() => memory(), 5)).toBe(false);
		const junk = memory();
		junk.setItem(DISMISS_KEY, 'junk');
		expect(isDismissed(() => junk, 5)).toBe(false);
	});
});
