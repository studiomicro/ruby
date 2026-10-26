import { enhance as kitEnhance, type SubmitFunction } from '$app/forms';
import { guardSubmit } from './offline-guard';
import { markOffline, markOnline } from './online.svelte';

/**
 * RB-20: the app's `enhance`. Every form imports it from here instead of `$app/forms` (test/pwa.test.ts), so a
 * form submitted offline keeps its input and says so, and nothing is queued (offline-guard.ts). Same signature and
 * behaviour as SvelteKit's `enhance` otherwise.
 */
const NOTE = 'offline-note';

function showNote(form: HTMLFormElement, message: string) {
	let note = form.querySelector<HTMLElement>(`:scope > .${NOTE}`);
	if (!note) {
		note = document.createElement('p');
		note.className = NOTE;
		note.setAttribute('role', 'alert');
		form.appendChild(note);
	}
	note.textContent = message;
}

function clearNote(form: HTMLFormElement) {
	form.querySelector(`:scope > .${NOTE}`)?.remove();
}

export function enhance<
	Success extends Record<string, unknown> | undefined = Record<string, unknown>,
	Failure extends Record<string, unknown> | undefined = Record<string, unknown>
>(form: HTMLFormElement, submit?: SubmitFunction<Success, Failure>) {
	return kitEnhance(
		form,
		guardSubmit(submit, {
			isOnline: () => navigator.onLine,
			showNote,
			clearNote,
			markOffline,
			markOnline
		})
	);
}
