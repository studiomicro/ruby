import { afterEach, describe, expect, it, vi } from 'vitest';
import { connection, markOffline, markOnline, watchConnection } from './online.svelte';

describe('online state (offline banner)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('follows navigator.onLine and the online/offline events, and stops on cleanup', () => {
		const listeners = new Map<string, () => void>();
		const nav = { onLine: false };
		vi.stubGlobal('navigator', nav);
		vi.stubGlobal('addEventListener', (type: string, fn: () => void) => listeners.set(type, fn));
		vi.stubGlobal('removeEventListener', (type: string) => listeners.delete(type));

		const stop = watchConnection();
		expect(connection.online).toBe(false);
		nav.onLine = true;
		listeners.get('online')!();
		expect(connection.online).toBe(true);
		nav.onLine = false;
		listeners.get('offline')!();
		expect(connection.online).toBe(false);
		stop();
		expect(listeners.size).toBe(0);
	});

	it('a failed form request marks it offline until a request reaches the server', () => {
		markOnline();
		markOffline();
		expect(connection.online).toBe(false);
		markOnline();
		expect(connection.online).toBe(true);
	});
});
