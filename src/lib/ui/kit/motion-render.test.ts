import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Button from './Button.svelte';
import Dialog from './Dialog.svelte';
import Toaster from './Toaster.svelte';
import { MAX_TOASTS, toasts } from './toast.svelte';

const text = (s: string) => createRawSnippet(() => ({ render: () => `<span>${s}</span>` }));

/**
 * RB-20 Part B (B-AC19): motion is presentation only. The server-rendered markup keeps its roles, labels and ids,
 * and no motion code writes a `style` attribute (the CSP allows none).
 */
describe('components with motion render the same markup', () => {
	it('Dialog: a native dialog labelled by its title, no style attribute', () => {
		const { body } = render(Dialog, {
			props: { open: false, title: 'Install Ruby', sheet: true, children: text('Steps') }
		});
		expect(body).toMatch(/<dialog[^>]*class="dialog md[^"]*sheet/);
		expect(body).toMatch(/aria-labelledby="[^"]+-title"/);
		expect(body).not.toMatch(/\sstyle=/);
	});

	it('Toaster: a polite live region; each toast keeps its role; three at most; no style attribute', () => {
		expect(MAX_TOASTS).toBe(3);
		toasts.push(
			{ id: 1, title: 'Saved', tone: 'success' },
			{ id: 2, title: 'Could not save', tone: 'error' }
		);
		try {
			const { body } = render(Toaster);
			expect(body).toMatch(/aria-live="polite"/);
			expect(body.match(/class="toast /g)).toHaveLength(2);
			expect(body).toMatch(/role="status"/);
			expect(body).toMatch(/role="alert"/);
			expect(body).not.toMatch(/\sstyle=/);
		} finally {
			toasts.length = 0;
		}
	});

	it('Button: "Saved" with a hidden tick after a confirmed save, otherwise its own label', () => {
		const saved = render(Button, {
			props: { type: 'submit', saved: true, children: text('Save name') }
		});
		expect(saved.body).toMatch(/<span class="tick[^"]*" aria-hidden="true"><\/span>Saved/);
		expect(saved.body).not.toContain('Save name');
		const plain = render(Button, { props: { type: 'submit', children: text('Save name') } });
		expect(plain.body).toContain('Save name');
		expect(plain.body).not.toMatch(/\sstyle=/);
	});
});
