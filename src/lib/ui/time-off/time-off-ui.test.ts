import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
// The form action enhancer only runs in a browser; server rendering never calls it.
vi.mock('$app/forms', () => ({ enhance: () => ({}) }));

const { default: BalanceCards } = await import('./BalanceCards.svelte');
const { default: RequestList } = await import('./RequestList.svelte');

/** `text` with `pattern` replaced until nothing matches (one pass can leave a new match behind). */
const replaceAll = (text: string, pattern: RegExp, by: string) => {
	for (let previous = ''; previous !== text;) {
		previous = text;
		text = text.replace(pattern, by);
	}
	return text;
};

/** The visible text of rendered HTML: tags and hydration comments removed, entities decoded, spaces collapsed. */
const textOf = (html: string) =>
	replaceAll(replaceAll(html, /<!--[^]*?-->/g, ''), /<[^>]+>/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
		.trim();

const item = {
	id: '00000000-0000-4000-8000-000000000001',
	typeName: 'Special <b>type</b>',
	startOn: '2026-11-02',
	endOn: '2026-11-03',
	halfDay: 'none' as const,
	halfDays: 4,
	reason: '<script>alert(1)</script> **not bold** <img src=x onerror=alert(1)>',
	status: 'rejected' as const,
	decidedByName: 'Fictional <i>Manager</i>',
	decisionNote: '[link](javascript:alert(1))',
	updatedAt: 1,
	cancelable: true
};

describe('RequestList', () => {
	it('renders reason, note, type and names as plain text', () => {
		const { body } = render(RequestList, { props: { requests: [item], label: 'Mine' } });
		expect(body).not.toContain('<script>');
		expect(body).not.toContain('<img');
		expect(body).not.toContain('<b>');
		expect(body).not.toContain('<a ');
		expect(textOf(body)).toContain('<script>alert(1)</script> **not bold**');
		expect(textOf(body)).toContain(
			'Rejected by Fictional <i>Manager</i>: [link](javascript:alert(1))'
		);
		expect(textOf(body)).toContain('2026-11-02 – 2026-11-03');
		expect(body).toContain('2 days');
	});
	it('offers Cancel only with an action and only for cancelable requests', () => {
		expect(render(RequestList, { props: { requests: [item], label: 'Mine' } }).body).not.toContain(
			'Cancel request'
		);
		const withAction = render(RequestList, {
			props: { requests: [item], label: 'Mine', cancelAction: '?/cancel' }
		}).body;
		expect(withAction).toContain('Cancel request');
		expect(withAction).toContain('name="expected" value="1"');
		const locked = render(RequestList, {
			props: { requests: [{ ...item, cancelable: false }], label: 'Mine', cancelAction: '?/cancel' }
		}).body;
		expect(locked).not.toContain('Cancel request');
	});
});

describe('RequestList self-approval', () => {
	it('marks a self-approved request as such', () => {
		const { body } = render(RequestList, {
			props: {
				requests: [
					{
						...item,
						status: 'approved',
						selfApproved: true,
						decidedByName: 'Owner',
						decisionNote: ''
					}
				],
				label: 'Mine'
			}
		});
		expect(textOf(body)).toContain('Self-approved by Owner');
		expect(textOf(body)).not.toContain('Approved by Owner');
	});
});

describe('BalanceCards', () => {
	it('shows days with .5 from half-days', () => {
		const { body } = render(BalanceCards, {
			props: {
				period: 2026,
				balances: [
					{
						typeId: 'lt_annual',
						typeName: 'Annual',
						entitled: 24,
						used: 3,
						pending: 2,
						available: 19
					}
				]
			}
		});
		expect(textOf(body)).toContain('9.5 days available');
		expect(textOf(body)).toContain('Entitled 12 Used 1.5 Pending 1');
	});
});
