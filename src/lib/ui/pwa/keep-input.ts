import { isDirty, type FormControl } from '#lib/ui/shell/dirty-forms';

/**
 * RB-20: Refresh reloads the page's data (`invalidateAll`), and a field whose value comes from that data is rendered
 * again with the server's value. This keeps what the person typed: it remembers every control that holds unsaved
 * input (the same rule as the update banner's dirty-form check) and puts the typed values back afterwards, firing
 * `input` and `change` so bound component state follows. A control that no longer exists is skipped.
 */
interface Control extends FormControl {
	value: string;
	checked: boolean;
	isConnected: boolean;
	dispatchEvent(event: Event): boolean;
}

export function rememberTypedInput(
	root: { querySelectorAll(selector: string): ArrayLike<unknown> } = document
): () => void {
	const typed = (
		Array.from(root.querySelectorAll('form input, form textarea, form select')) as Control[]
	)
		.filter(isDirty)
		.map((control) => ({ control, value: control.value, checked: control.checked }));
	return () => {
		for (const { control, value, checked } of typed) {
			if (!control.isConnected) continue;
			if (control.type === 'checkbox' || control.type === 'radio') control.checked = checked;
			else control.value = value;
			control.dispatchEvent(new Event('input', { bubbles: true }));
			control.dispatchEvent(new Event('change', { bubbles: true }));
		}
	};
}
