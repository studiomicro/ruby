/**
 * Toasts: short, passing messages (Kumo Toast), shown by the one <Toaster /> in the app shell. Call `showToast` only
 * in the browser and only after the server has confirmed the write: a toast is never persistence, and never the only
 * place an error that needs action is shown (CLAUDE.md). An error toast is announced at once (role="alert"), the
 * others politely.
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
	id: number;
	title: string;
	description?: string;
	tone: ToastTone;
}

/** The toasts on screen, oldest first. At most `MAX_TOASTS`; the oldest goes when another arrives. */
export const toasts: Toast[] = $state([]);

export const MAX_TOASTS = 3;
let nextId = 1;

export function showToast(
	title: string,
	options: { description?: string; tone?: ToastTone; timeout?: number } = {}
): number {
	// Module state is shared by every request on the server: never queue a toast there.
	if (typeof window === 'undefined') return 0;
	const id = nextId++;
	toasts.push({ id, title, description: options.description, tone: options.tone ?? 'success' });
	while (toasts.length > MAX_TOASTS) toasts.shift();
	const timeout = options.timeout ?? 5000;
	if (timeout > 0) setTimeout(() => dismissToast(id), timeout);
	return id;
}

export function dismissToast(id: number): void {
	const index = toasts.findIndex((toast) => toast.id === id);
	if (index >= 0) toasts.splice(index, 1);
}
