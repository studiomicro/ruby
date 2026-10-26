import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Avatar from './Avatar.svelte';
import Badge from './Badge.svelte';
import Banner from './Banner.svelte';
import Button from './Button.svelte';
import EmptyState from './EmptyState.svelte';
import { initials } from './initials';
import Markdown from './Markdown.svelte';
import Select from './Select.svelte';
import TextArea from './TextArea.svelte';
import TextField from './TextField.svelte';

const text = (s: string) => createRawSnippet(() => ({ render: () => `<span>${s}</span>` }));

describe('form fields', () => {
	it('TextField ties its label to the input and its error to aria-describedby', () => {
		const { body } = render(TextField, {
			props: {
				label: 'E-mail',
				name: 'email',
				type: 'email',
				error: 'Enter a valid e-mail address.'
			}
		});
		const id = body.match(/<input[^>]*\sid="([^"]+)"/)?.[1];
		expect(id).toBeTruthy();
		expect(body).toMatch(new RegExp(`<label[^>]*for="${id}"`));
		expect(body).toMatch(/aria-invalid="true"/);
		expect(body).toMatch(new RegExp(`aria-describedby="${id}-error"`));
		expect(body).toContain(`id="${id}-error"`);
		expect(body).toContain('Enter a valid e-mail address.');
	});

	it('TextField without an error is not marked invalid', () => {
		const { body } = render(TextField, { props: { label: 'Name', name: 'name', value: 'Dewi' } });
		expect(body).not.toContain('aria-invalid');
		expect(body).toMatch(/value="Dewi"/);
	});

	it('TextArea and Select are labelled too', () => {
		const area = render(TextArea, { props: { label: 'Description', name: 'description' } }).body;
		expect(area).toMatch(/<label[^>]*for="([^"]+)"[\s\S]*<textarea[^>]*id="\1"/);
		const select = render(Select, {
			props: {
				label: 'Role',
				name: 'role',
				value: 'admin',
				options: [
					{ value: 'member', label: 'Member' },
					{ value: 'admin', label: 'Admin' }
				]
			}
		}).body;
		expect(select).toMatch(/<label[^>]*for="([^"]+)"[\s\S]*<select[^>]*id="\1"/);
		expect(select).toMatch(/<option value="admin"[^>]*selected/);
	});
});

describe('Button', () => {
	it('is disabled and busy while loading, with the loading label', () => {
		const { body } = render(Button, {
			props: { type: 'submit', loading: true, loadingLabel: 'Saving…', children: text('Save') }
		});
		expect(body).toMatch(/<button[^>]*type="submit"/);
		expect(body).toMatch(/\sdisabled/);
		expect(body).toMatch(/aria-busy="true"/);
		expect(body).toContain('Saving…');
	});
	it('renders a link with href', () => {
		expect(
			render(Button, { props: { href: '/projects', children: text('Projects') } }).body
		).toMatch(/<a href="\/projects"/);
	});
});

describe('display components', () => {
	it('Banner renders nothing without a message, and alerts on error', () => {
		expect(render(Banner, { props: { tone: 'error', message: null } }).body).not.toContain(
			'banner'
		);
		expect(render(Banner, { props: { tone: 'error', message: 'No.' } }).body).toMatch(
			/role="alert"/
		);
		expect(render(Banner, { props: { tone: 'success', message: 'Saved.' } }).body).toMatch(
			/role="status"/
		);
	});
	it('Badge, EmptyState and Avatar render their text', () => {
		expect(render(Badge, { props: { tone: 'accent', children: text('Admin') } }).body).toContain(
			'Admin'
		);
		const empty = render(EmptyState, {
			props: { title: 'No projects yet', action: { href: '/projects/new', label: 'New project' } }
		}).body;
		expect(empty).toContain('No projects yet');
		expect(empty).toContain('href="/projects/new"');
		expect(render(Avatar, { props: { name: 'Dewi Ayu Lestari' } }).body).toContain('DL');
	});
	it('initials', () => {
		expect(initials('Dewi Ayu Lestari')).toBe('DL');
		expect(initials('budi')).toBe('B');
		expect(initials('  ')).toBe('?');
	});
});

describe('Markdown', () => {
	it('renders only through the sanitising renderer', () => {
		const { body } = render(Markdown, {
			props: { source: '**bold** <script>alert(1)</script> [x](javascript:alert(1))' }
		});
		expect(body).toContain('<strong>bold</strong>');
		expect(body).not.toMatch(/<script/);
		expect(body).not.toContain('href="javascript');
		expect(body).toContain('class="markdown"');
	});
	it('passes names to the renderer: a mention shows the real name', () => {
		const id = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
		const { body } = render(Markdown, {
			props: { source: `@[Ada Admin](user:${id})`, names: new Map([[id, 'Ivo Intern']]) }
		});
		expect(body).toContain('@Ivo Intern');
		expect(body).not.toContain('Ada Admin');
	});
	it('shows the empty text for an empty source', () => {
		expect(render(Markdown, { props: { source: '', empty: 'No description.' } }).body).toContain(
			'No description.'
		);
	});
});
