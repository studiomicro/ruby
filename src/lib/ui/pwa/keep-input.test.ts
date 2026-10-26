import { describe, expect, it } from 'vitest';
import { rememberTypedInput } from './keep-input';

class FakeControl {
	events: string[] = [];
	isConnected = true;
	constructor(
		public type: string,
		public value: string,
		public defaultValue: string,
		public checked = false,
		public defaultChecked = false
	) {}
	dispatchEvent(event: Event) {
		this.events.push(event.type);
		return true;
	}
}

describe('rememberTypedInput (Refresh keeps typed input)', () => {
	it('puts back only what was typed, and tells bound state about it', () => {
		const typed = new FakeControl('text', 'typed', 'server');
		const clean = new FakeControl('text', 'server', 'server');
		const ticked = new FakeControl('checkbox', 'on', 'on', true, false);
		const gone = new FakeControl('text', 'typed too', 'x');
		const restore = rememberTypedInput({ querySelectorAll: () => [typed, clean, ticked, gone] });
		// invalidateAll re-rendered the fields with the server's values; one field disappeared.
		typed.value = 'server';
		clean.value = 'fresh from server';
		ticked.checked = false;
		gone.isConnected = false;
		gone.value = 'x';
		restore();
		expect(typed.value).toBe('typed');
		expect(typed.events).toEqual(['input', 'change']);
		expect(clean.value).toBe('fresh from server');
		expect(clean.events).toEqual([]);
		expect(ticked.checked).toBe(true);
		expect(gone.value).toBe('x');
	});
});
