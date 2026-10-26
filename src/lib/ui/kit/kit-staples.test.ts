import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Card from './Card.svelte';
import Checkbox from './Checkbox.svelte';
import Dialog from './Dialog.svelte';
import DropdownMenu from './DropdownMenu.svelte';
import Switch from './Switch.svelte';
import Table from './Table.svelte';
import Tabs from './Tabs.svelte';
import Toaster from './Toaster.svelte';
import { dismissToast, MAX_TOASTS, showToast, toasts } from './toast.svelte';

/** RB-10: the Kumo staples added to the kit render accessible markup on the server. */

const text = (s: string) => createRawSnippet(() => ({ render: () => `<span>${s}</span>` }));

describe('Tabs', () => {
	it('with hrefs is a named nav of links, the current one aria-current', () => {
		const { body } = render(Tabs, {
			props: {
				label: 'Project',
				value: 'board',
				items: [
					{ id: 'list', label: 'List', href: '/p?view=list' },
					{ id: 'board', label: 'Board', href: '/p?view=board' }
				]
			}
		});
		expect(body).toMatch(/<nav[^>]*aria-label="Project"/);
		expect(body).toMatch(/<a[^>]*href="\/p\?view=board"[^>]*aria-current="page"/);
		expect(body).not.toMatch(/<a[^>]*href="\/p\?view=list"[^>]*aria-current/);
		expect(body).not.toContain('role="tab"');
	});
	it('without hrefs is a tablist with one selected, focusable tab and a labelled panel', () => {
		const panel = createRawSnippet((id: () => string) => ({
			render: () => `<p>Panel ${id()}</p>`
		}));
		const { body } = render(Tabs, {
			props: {
				label: 'Sections',
				value: 'b',
				panel,
				items: [
					{ id: 'a', label: 'A' },
					{ id: 'b', label: 'B' }
				]
			}
		});
		expect(body).toMatch(/role="tablist"[^>]*aria-label="Sections"/);
		expect(body.match(/role="tab"/g)).toHaveLength(2);
		expect(body.match(/aria-selected="true"/g)).toHaveLength(1);
		const selectedId = body.match(/id="([^"]+)"[^>]*aria-selected="true"/)?.[1];
		expect(selectedId).toBeTruthy();
		expect(body).toMatch(new RegExp(`role="tabpanel"[^>]*aria-labelledby="${selectedId}"`));
		expect(body).toContain('Panel b');
	});
	it('falls back to the first tab when the value matches none', () => {
		const { body } = render(Tabs, {
			props: { label: 'S', items: [{ id: 'a', label: 'A' }] }
		});
		expect(body).toMatch(/aria-selected="true"[^>]*tabindex="0"/);
	});
});

describe('Dialog', () => {
	it('is a native dialog labelled by its title and described by its description, with a close button', () => {
		const { body } = render(Dialog, {
			props: { title: 'Delete page', description: 'This cannot be undone.', children: text('x') }
		});
		const labelled = body.match(/<dialog[^>]*aria-labelledby="([^"]+)"/)?.[1];
		const described = body.match(/<dialog[^>]*aria-describedby="([^"]+)"/)?.[1];
		expect(body).toMatch(new RegExp(`<h2[^>]*id="${labelled}"[^>]*>Delete page</h2>`));
		expect(body).toMatch(new RegExp(`id="${described}"[^>]*>This cannot be undone.`));
		expect(body).toMatch(/<button[^>]*aria-label="Close"/);
		// Closed until showModal() runs in the browser.
		expect(body).not.toMatch(/<dialog[^>]*\sopen/);
	});
});

describe('DropdownMenu', () => {
	it('is a menu button whose hidden menu holds links, POST forms and buttons as menu items', () => {
		const { body } = render(DropdownMenu, {
			props: {
				label: 'Actions',
				items: [
					{ label: 'Open', href: '/kb' },
					{ label: 'Sign out', action: '/logout', danger: true },
					{ label: 'Copy', onselect: () => {} }
				]
			}
		});
		const menuId = body.match(/aria-controls="([^"]+)"/)?.[1];
		expect(body).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
		expect(body).toMatch(new RegExp(`id="${menuId}"[^>]*role="menu"[^>]*hidden`));
		expect(body.match(/role="menuitem"/g)).toHaveLength(3);
		expect(body).toMatch(
			/<form method="POST" action="\/logout"[^>]*><button role="menuitem"[^>]*type="submit"/
		);
	});
	it('an icon-only trigger is named by its label', () => {
		const { body } = render(DropdownMenu, {
			props: {
				label: 'More actions',
				icon: 'more',
				hideLabel: true,
				items: [{ label: 'A', href: '/' }]
			}
		});
		expect(body).toMatch(/<button[^>]*aria-label="More actions"/);
	});
});

describe('Checkbox and Switch', () => {
	it('Checkbox ties its label, description and error to a native checkbox', () => {
		const { body } = render(Checkbox, {
			props: {
				label: 'Notify me',
				name: 'notify',
				checked: true,
				description: 'By e-mail.',
				error: 'Required.'
			}
		});
		const id = body.match(/<input[^>]*type="checkbox"[^>]*\sid="([^"]+)"/)?.[1];
		expect(body).toMatch(new RegExp(`<label for="${id}"[^>]*>Notify me</label>`));
		expect(body).toMatch(/<input[^>]*checked/);
		expect(body).toMatch(new RegExp(`aria-describedby="${id}-error ${id}-description"`));
		expect(body).toMatch(/aria-invalid="true"/);
	});
	it('Switch is a checkbox with role="switch", so it posts like one', () => {
		const { body } = render(Switch, { props: { label: 'Weekly digest', name: 'digest' } });
		expect(body).toMatch(/<input[^>]*type="checkbox"[^>]*role="switch"[^>]*name="digest"/);
		expect(body).not.toMatch(/<input[^>]*checked/);
	});
});

describe('Table and Card', () => {
	it('Table is a focusable scroll region named by its caption', () => {
		const rows = createRawSnippet(() => ({
			render: () => '<tbody><tr><td>1</td></tr></tbody>'
		}));
		const { body } = render(Table, { props: { caption: 'Open tasks', children: rows } });
		expect(body).toMatch(/role="region"[^>]*aria-label="Open tasks"[^>]*tabindex="0"/);
		expect(body).toMatch(/<caption class="[^"]*sr-only[^"]*">Open tasks<\/caption>/);
	});
	it('Card with a title is a section labelled by a heading of the given level', () => {
		const { body } = render(Card, { props: { title: 'Invites', level: 3, children: text('x') } });
		const id = body.match(/<section[^>]*aria-labelledby="([^"]+)"/)?.[1];
		expect(body).toMatch(new RegExp(`<h3[^>]*id="${id}"[^>]*>Invites(<!---->)?</h3>`));
		expect(render(Card, { props: { children: text('x') } }).body).not.toContain('<section');
	});
});

describe('toasts', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		toasts.splice(0);
	});
	it('are never queued on the server', () => {
		expect(showToast('Saved')).toBe(0);
		expect(toasts).toHaveLength(0);
	});
	it('show, keep at most MAX_TOASTS, expire and dismiss', () => {
		vi.stubGlobal('window', {});
		vi.useFakeTimers();
		const first = showToast('One', { timeout: 1000 });
		for (let i = 0; i < MAX_TOASTS; i++) showToast(`More ${i}`, { timeout: 0 });
		expect(toasts).toHaveLength(MAX_TOASTS);
		expect(toasts.some((t) => t.id === first)).toBe(false);
		const id = showToast('Failed', { tone: 'error', timeout: 1000 });
		vi.advanceTimersByTime(1000);
		expect(toasts.some((t) => t.id === id)).toBe(false);
		dismissToast(toasts[0]!.id);
		expect(toasts).toHaveLength(MAX_TOASTS - 2);
	});
	it('the Toaster is a polite live region from the first paint; an error toast is an alert', () => {
		expect(render(Toaster).body).toMatch(
			/<section[^>]*aria-label="Messages"[^>]*aria-live="polite"/
		);
		vi.stubGlobal('window', {});
		showToast('Upload failed', { tone: 'error', timeout: 0 });
		const { body } = render(Toaster);
		expect(body).toMatch(/role="alert"[^>]*>[\s\S]*Upload failed/);
		expect(body).toMatch(/aria-label="Dismiss"/);
	});
});
