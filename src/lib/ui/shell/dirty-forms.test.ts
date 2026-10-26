import { describe, expect, it } from 'vitest';
import { hasDirtyForm, isDirty } from './dirty-forms';

describe('isDirty', () => {
	it('text differs from its default', () => {
		expect(isDirty({ type: 'text', value: 'a', defaultValue: '' })).toBe(true);
		expect(isDirty({ type: 'text', value: 'a', defaultValue: 'a' })).toBe(false);
		expect(isDirty({ value: 'x', defaultValue: '' })).toBe(true);
	});
	it('checkbox, radio and select compare with their defaults', () => {
		expect(isDirty({ type: 'checkbox', checked: true, defaultChecked: false })).toBe(true);
		expect(isDirty({ type: 'radio', checked: false, defaultChecked: false })).toBe(false);
		expect(
			isDirty({ type: 'select-one', options: [{ selected: true, defaultSelected: false }] })
		).toBe(true);
	});
	it('ignores hidden, submit and file controls', () => {
		for (const type of ['hidden', 'submit', 'button', 'file'])
			expect(isDirty({ type, value: 'x', defaultValue: '' })).toBe(false);
	});
});

describe('hasDirtyForm', () => {
	const root = (controls: object[]) => ({
		querySelectorAll: () => controls
	});
	it('is true when any control is dirty', () => {
		const clean = { type: 'text', value: '', defaultValue: '' };
		const dirty = { type: 'text', value: 'draft', defaultValue: '' };
		expect(hasDirtyForm(root([clean]) as never)).toBe(false);
		expect(hasDirtyForm(root([clean, dirty]) as never)).toBe(true);
		expect(hasDirtyForm(root([]) as never)).toBe(false);
	});
});
