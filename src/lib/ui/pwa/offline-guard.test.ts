import type { ActionResult } from '$app/forms';
import { describe, expect, it, vi } from 'vitest';
import { isNetworkError } from './network-error';
import {
	CONNECTION_LOST_MESSAGE,
	guardSubmit,
	isOfflineResult,
	OFFLINE_FORM_MESSAGE
} from './offline-guard';

type Input = Parameters<ReturnType<typeof guardSubmit>>[0];
interface Opts {
	formElement: HTMLFormElement;
	result: ActionResult;
	update: () => Promise<void>;
}
type Callback = (opts: Opts) => Promise<void>;
/** Results as the client sees them (App.Error's own fields are not the point here). */
const result = (value: unknown) => value as ActionResult;

function setup(online: boolean) {
	const form = {} as HTMLFormElement;
	const deps = {
		isOnline: () => online,
		showNote: vi.fn(),
		clearNote: vi.fn(),
		markOffline: vi.fn(),
		markOnline: vi.fn()
	};
	const cancel = vi.fn();
	const input = { formElement: form, cancel } as unknown as Input;
	const opts = (value: ActionResult): Opts => ({
		formElement: form,
		result: value,
		update: vi.fn(async () => {})
	});
	return { form, deps, cancel, input, opts };
}

describe('guardSubmit', () => {
	it('offline: the request is never sent, the note shows, the page handler never runs', async () => {
		const { deps, cancel, input } = setup(false);
		const page = vi.fn();
		const callback = await guardSubmit(page, deps)(input);
		expect(cancel).toHaveBeenCalledOnce();
		expect(callback).toBeUndefined();
		expect(page).not.toHaveBeenCalled();
		// Never sent: "Nothing was saved" is true.
		expect(deps.showNote).toHaveBeenCalledExactlyOnceWith(input.formElement, OFFLINE_FORM_MESSAGE);
		expect(deps.markOffline).toHaveBeenCalledOnce();
	});

	it('a network failure applies nothing, shows the note, and lets the page handler leave its saving state', async () => {
		const { deps, cancel, input, opts } = setup(true);
		const pageCallback = vi.fn(async (o: Opts) => {
			await o.update();
		});
		const callback = (await guardSubmit(() => pageCallback, deps)(input)) as Callback | undefined;
		expect(cancel).not.toHaveBeenCalled();
		const o = opts(
			result({ type: 'error', error: { message: 'You are offline.', offline: true } })
		);
		await callback!(o);
		// Sent, answer lost: the server may have applied it, so the note never claims nothing was saved.
		expect(deps.showNote).toHaveBeenCalledExactlyOnceWith(o.formElement, CONNECTION_LOST_MESSAGE);
		expect(deps.markOffline).toHaveBeenCalledOnce();
		expect(pageCallback).toHaveBeenCalledOnce();
		// The page's handler called update(), but the real update (which would show an error page) never ran.
		expect(o.update).not.toHaveBeenCalled();
	});

	it('a network failure on a plain form (no handler) applies nothing', async () => {
		const { deps, input, opts } = setup(true);
		const callback = (await guardSubmit(undefined, deps)(input)) as Callback | undefined;
		const o = opts(
			result({ type: 'error', error: { message: 'You are offline.', offline: true } })
		);
		await callback!(o);
		expect(o.update).not.toHaveBeenCalled();
		expect(deps.showNote).toHaveBeenCalledExactlyOnceWith(o.formElement, CONNECTION_LOST_MESSAGE);
	});

	it('an answer from the server is applied as usual and marks the device online', async () => {
		const { deps, input, opts } = setup(true);
		const plain = (await guardSubmit(undefined, deps)(input)) as Callback | undefined;
		const success = opts(result({ type: 'success', status: 200 }));
		await plain!(success);
		expect(success.update).toHaveBeenCalledOnce();
		const serverError = opts(result({ type: 'error', status: 500, error: { message: 'x' } }));
		await plain!(serverError);
		expect(serverError.update).toHaveBeenCalledOnce();
		expect(deps.markOnline).toHaveBeenCalledTimes(2);
		expect(deps.showNote).not.toHaveBeenCalled();
		expect(deps.clearNote).toHaveBeenCalledOnce();
	});

	it('only the never-sent message says nothing was saved; the lost-answer one says it may have been', () => {
		expect(OFFLINE_FORM_MESSAGE).toBe(
			'You are offline. Nothing was saved. Try again when you are back online.'
		);
		expect(CONNECTION_LOST_MESSAGE).toContain('may have been saved');
		expect(CONNECTION_LOST_MESSAGE).not.toContain('Nothing was saved');
		expect(isOfflineResult(result({ type: 'error', error: { message: 'x' } }))).toBe(false);
		expect(isOfflineResult(result({ type: 'failure', status: 400 }))).toBe(false);
	});
});

describe('isNetworkError', () => {
	it("recognises each browser's fetch failure, and anything while offline", () => {
		for (const message of [
			'Failed to fetch',
			'Load failed',
			'NetworkError when attempting to fetch resource.',
			'The network connection was lost.'
		])
			expect(isNetworkError(new TypeError(message), true), message).toBe(true);
		expect(isNetworkError(new TypeError('x is not a function'), false)).toBe(true);
	});
	it('a bug in the page stays an ordinary error', () => {
		expect(isNetworkError(new TypeError('x is not a function'), true)).toBe(false);
		expect(isNetworkError(new Error('Failed to fetch'), true)).toBe(false);
		expect(isNetworkError('Failed to fetch', false)).toBe(false);
	});
});
