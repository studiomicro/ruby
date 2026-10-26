import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { getDb, type Db } from '#lib/server/db';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { clearCalendar } from '../helpers/seed-calendar';
import { insertUser } from '../helpers/users';

/**
 * RB-09 Markdown and plain-text safety (acceptance 12): an event whose description carries the checklist's XSS
 * vectors renders inert on its detail page (server render of the real page with the real load), and the calendar
 * shows titles only, as text. Title, location and attendee names are text everywhere.
 */

vi.mock('#lib/server/env', () => ({ getEnv: () => ({ TEAM_TIME_ZONE: 'Asia/Jakarta' }) }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
// RB-20 Part B: the calendar page steps its grid on navigation; no navigation happens in a server render.
vi.mock('$app/navigation', () => ({ afterNavigate: () => {} }));

const newEvent = await import('../../src/routes/(app)/calendar/events/new/+page.server');
const detail = await import('../../src/routes/(app)/calendar/events/[id]/+page.server');
const calendar = await import('../../src/routes/(app)/calendar/+page.server');
const DetailPage = (await import('../../src/routes/(app)/calendar/events/[id]/+page.svelte'))
	.default;
const CalendarPage = (await import('../../src/routes/(app)/calendar/+page.svelte')).default;

let db: Db;
let dispose: () => Promise<void>;

beforeAll(async () => {
	const opened = await openLocalD1();
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(async () => {
	await clearCalendar(db);
});

const VECTORS = [
	'<script>alert(1)</script>',
	'<img src=x onerror=alert(1)>',
	'<IMG SRC=x OnErRoR=alert(1)>',
	'[a](javascript:alert(1))',
	'[b](JaVaScRiPt:alert(1))',
	'[c](&#106;avascript:alert(1))',
	'[d](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
	'[e](vbscript:msgbox(1))',
	'![f](javascript:alert(1))',
	'![g](data:image/svg+xml,<svg onload=alert(1)>)',
	'<a href="javascript:alert(1)">h</a>',
	'**bold** stays Markdown'
].join('\n\n');

function inert(html: string) {
	expect(html).not.toMatch(/<script/i);
	// No real tag carries an event handler. Quoted attribute values (a chip's `title`) and escaped text such as
	// `&lt;img … onerror=` are inert, so they are blanked before the check.
	expect(html.replace(/"[^"]*"/g, '""')).not.toMatch(/<[a-z][^<>]*\son\w+=/i);
	expect(html).not.toMatch(/(href|src)="\s*(javascript|vbscript|data):/i);
	expect(html).not.toMatch(/(href|src)="&#/i);
}

describe('event page XSS vectors', () => {
	it('render inert on the detail page and never reach the calendar', async () => {
		const user = await insertUser(db, { name: '<b>Eve</b> "quote"' });
		const create = newEvent.actions.create as (event: never) => Promise<unknown>;
		const created = await create(
			fakeEvent({
				url: 'http://localhost/calendar/events/new',
				db,
				user,
				form: {
					title: '<img src=x onerror=alert(1)> Review',
					description: VECTORS,
					location: 'javascript:alert(1) <script>x</script>',
					startDate: '2026-11-02',
					startTime: '14:00',
					endDate: '2026-11-02',
					endTime: '15:00',
					visibility: 'team'
				}
			}).event as never
		).catch((e: unknown) => e);
		const id = String((created as { location: string }).location).match(
			/events\/([0-9a-f-]{36})/
		)?.[1];
		expect(id).toBeTruthy();

		const data = await detail.load(
			fakeEvent({ url: `http://localhost/calendar/events/${id}`, db, user, params: { id: id! } })
				.event as never
		);
		const { body } = render(DetailPage, { props: { data: data as never, form: null as never } });
		inert(body);
		expect(body).toContain('<strong>bold</strong>');
		expect(body).toContain('&lt;img src=x onerror=alert(1)> Review');
		expect(body).toContain('javascript:alert(1) &lt;script>x&lt;/script>');

		const cal = await calendar.load(
			fakeEvent({ url: 'http://localhost/calendar?view=month&date=2026-11-02', db, user })
				.event as never
		);
		expect(JSON.stringify(cal)).not.toContain('PHNjcmlwdD5');
		expect(JSON.stringify(cal)).not.toContain('Room');
		const page = render(CalendarPage, { props: { data: cal as never } });
		inert(page.body);
		expect(page.body).toContain('&lt;img src=x onerror=alert(1)> Review');
		expect(page.body).not.toContain('bold stays');
	});
});
