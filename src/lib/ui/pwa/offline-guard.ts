import type { ActionResult, SubmitFunction } from '$app/forms';

/**
 * The offline rule for every enhanced form (RB-20), pure so it is unit-tested (offline-guard.test.ts); wired to the
 * browser by offline-form.ts. Nothing is ever queued, stored, retried or replayed:
 *
 * - a submit while the device is offline is not sent at all, and says OFFLINE_FORM_MESSAGE ("Nothing was saved" is
 *   true: no request left the device);
 * - a submit whose request fails with a network error applies nothing (the form keeps its input, no error page) and
 *   says CONNECTION_LOST_MESSAGE: the browser reports the same error whether the request never arrived or only its
 *   answer was lost, so the change may have been saved and the person is told to check before trying again;
 * - in both cases the page's own callback still runs (with an `update` that does nothing) so its submit button leaves
 *   the saving state.
 *
 * Success is still shown only after the server answered.
 */
export const OFFLINE_FORM_MESSAGE =
	'You are offline. Nothing was saved. Try again when you are back online.';
export const CONNECTION_LOST_MESSAGE =
	'The connection dropped. Your change may have been saved. Reload the page to check before trying again.';

/** A request whose answer never arrived: the client error hook (src/hooks.client.ts) marks it `offline`. */
export function isOfflineResult(result: ActionResult): boolean {
	return result.type === 'error' && (result.error as App.Error | undefined)?.offline === true;
}

export interface GuardDeps {
	isOnline: () => boolean;
	showNote: (form: HTMLFormElement, message: string) => void;
	clearNote: (form: HTMLFormElement) => void;
	markOffline: () => void;
	markOnline: () => void;
}

export function guardSubmit<
	Success extends Record<string, unknown> | undefined,
	Failure extends Record<string, unknown> | undefined
>(
	submit: SubmitFunction<Success, Failure> | undefined,
	deps: GuardDeps
): SubmitFunction<Success, Failure> {
	return async (input) => {
		deps.clearNote(input.formElement);
		if (!deps.isOnline()) {
			input.cancel();
			deps.markOffline();
			deps.showNote(input.formElement, OFFLINE_FORM_MESSAGE);
			return;
		}
		const callback = submit ? await submit(input) : undefined;
		return async (opts) => {
			if (isOfflineResult(opts.result)) {
				deps.markOffline();
				deps.showNote(opts.formElement, CONNECTION_LOST_MESSAGE);
				if (callback) await callback({ ...opts, update: async () => {} });
				return;
			}
			deps.markOnline();
			if (callback) await callback(opts);
			else await opts.update();
		};
	};
}
