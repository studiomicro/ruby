/** The part of a form control that tells whether the user changed it. */
export interface FormControl {
	type?: string;
	value?: string;
	defaultValue?: string;
	checked?: boolean;
	defaultChecked?: boolean;
	options?: ArrayLike<{ selected: boolean; defaultSelected: boolean }>;
}

const IGNORED = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);

/** Whether one control holds input the user has not saved (differs from what the server rendered). */
export function isDirty(control: FormControl): boolean {
	const type = control.type ?? 'text';
	if (IGNORED.has(type)) return false;
	if (type === 'checkbox' || type === 'radio') return control.checked !== control.defaultChecked;
	if (control.options)
		return Array.from(control.options).some((o) => o.selected !== o.defaultSelected);
	return (control.value ?? '') !== (control.defaultValue ?? '');
}

/** Whether any form on the page has unsaved input. */
export function hasDirtyForm(
	root: { querySelectorAll(selector: string): ArrayLike<unknown> } = document
): boolean {
	const controls = root.querySelectorAll('form input, form textarea, form select');
	return (Array.from(controls) as FormControl[]).some(isDirty);
}
