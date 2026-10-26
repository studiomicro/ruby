<script lang="ts">
	import {
		addDays,
		calendarHref,
		formatDay,
		formatMonth,
		stepAnchor,
		type CalendarFilter,
		type CalendarSource,
		type CalendarView
	} from '#lib/shared/calendar';
	import { afterNavigate } from '$app/navigation';
	import { groupByDay } from '#lib/shared/calendar-items';
	import { DURATION_MS, EASE_OUT, motionAllowed } from '#lib/ui/motion';
	import Chip from '#lib/ui/calendar/Chip.svelte';
	import ItemLine from '#lib/ui/calendar/ItemLine.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Card from '#lib/ui/kit/Card.svelte';
	import Checkbox from '#lib/ui/kit/Checkbox.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import Tabs from '#lib/ui/kit/Tabs.svelte';

	let { data } = $props();

	/**
	 * RB-20 Part B: a calendar step or view switch is a navigation within this page. The calendar itself (not the page)
	 * moves once: 8 px from the side it comes from for previous/next, a slight zoom for a view switch. Never on the first
	 * load; nothing under reduced motion. `data-dir` on the blocks records the last direction.
	 */
	let dir = $state<'next' | 'prev' | 'view' | 'none'>('none');
	/** The view and date on screen before this navigation (set by the first, `enter`, navigation). */
	let shown: { view: string | null; date: string } = { view: null, date: '' };
	afterNavigate((navigation) => {
		const next = { view: data.filter.view as string | null, date: data.filter.date as string };
		dir =
			navigation.type === 'enter'
				? 'none'
				: next.view !== shown.view
					? 'view'
					: next.date > shown.date
						? 'next'
						: next.date < shown.date
							? 'prev'
							: 'none';
		shown = next;
		if (dir === 'none' || !motionAllowed()) return;
		const keyframes =
			dir === 'view'
				? [
						{ opacity: 0, transform: 'scale(0.98)' },
						{ opacity: 1, transform: 'none' }
					]
				: [
						{ opacity: 0, transform: `translateX(${dir === 'next' ? 8 : -8}px)` },
						{ opacity: 1, transform: 'none' }
					];
		for (const block of document.querySelectorAll('.cal-block'))
			block.animate(keyframes, { duration: DURATION_MS.slow, easing: EASE_OUT });
	});

	const f = $derived(data.filter as CalendarFilter);
	const zone = $derived(data.clock.zone);
	const label = $derived(data.clock.zoneLabel);
	const today = $derived(data.clock.today);
	const auto = $derived(f.view === null);
	const href = (changes: Partial<CalendarFilter>) => calendarHref(f, changes, data.available);

	const grid = $derived(data.ranges.grid);
	const gridDays = $derived(grid ? groupByDay(data.items, grid) : []);
	const agendaDays = $derived(
		data.ranges.agenda
			? groupByDay(data.items, data.ranges.agenda).filter((d) => d.items.length > 0)
			: []
	);
	const selectedDay = $derived(gridDays.find((d) => d.date === f.date) ?? gridDays[0]);
	const period = $derived(
		f.view === 'week' && grid
			? `${formatDay(grid.from)} – ${formatDay(grid.to, true)}`
			: f.view === 'agenda' && data.ranges.agenda
				? `${formatDay(data.ranges.agenda.from)} – ${formatDay(data.ranges.agenda.to, true)}`
				: formatMonth(f.date)
	);
	const month = $derived(f.date.slice(0, 7));
	const VIEWS: { view: CalendarView; label: string }[] = [
		{ view: 'month', label: 'Month' },
		{ view: 'week', label: 'Week' },
		{ view: 'agenda', label: 'Agenda' }
	];
	const SOURCE_LABEL: Record<CalendarSource, string> = {
		tasks: 'Tasks',
		milestones: 'Milestones',
		events: 'Events',
		timeoff: 'Time off'
	};
	const activeFilters = $derived(
		[
			f.show.length < data.available.length ? f.show.map((s) => SOURCE_LABEL[s]).join(', ') : null,
			f.tasks === 'all' ? 'Everyone’s tasks' : f.tasks === 'project' ? 'Project tasks' : 'My tasks',
			f.project ? `Project ${f.project}` : null,
			f.done ? 'Completed shown' : null,
			f.mine ? 'Only my events' : null
		].filter(Boolean) as string[]
	);
	const projectOptions = $derived([
		{ value: '', label: 'All projects' },
		...data.projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` }))
	]);
	const viewTabs = $derived(
		VIEWS.map((v) => ({ id: v.view, label: v.label, href: href({ view: v.view }) }))
	);
	const taskOptions = [
		{ value: 'mine', label: 'Assigned to me' },
		{ value: 'all', label: 'Everyone’s' }
	];
	const MAX_CHIPS = 3;
</script>

<PageHeader title="Calendar" description="Times are in {label}.">
	{#snippet actions()}
		<Button href="/reminders" variant="ghost">My reminders</Button>
		<Button href="/calendar/events/new?date={f.date}" variant="primary">Add event</Button>
	{/snippet}
</PageHeader>

<nav class="toolbar" aria-label="Calendar navigation">
	<div class="steps">
		<a class="step" href={href({ date: stepAnchor(f.view, f.date, -1) })} aria-label="Previous">‹</a
		>
		<a class="step" href={href({ date: today })}>Today</a>
		<a class="step" href={href({ date: stepAnchor(f.view, f.date, 1) })} aria-label="Next">›</a>
	</div>
	<h2 class="period">{period}</h2>
	<!-- Without `view`, no segment is current: the phone shows the agenda and a wide screen the month. -->
	<Tabs items={viewTabs} value={f.view ?? ''} label="View" variant="segmented" />
</nav>

<details class="filters">
	<summary>Filters{activeFilters.length ? ` · ${activeFilters.join(' · ')}` : ''}</summary>
	<form method="GET" action="/calendar" class="filter-form">
		{#if f.view}<input type="hidden" name="view" value={f.view} />{/if}
		<input type="hidden" name="date" value={f.date} />
		<fieldset>
			<legend>Show</legend>
			<div class="checks">
				{#each data.available as s (s)}
					<Checkbox label={SOURCE_LABEL[s]} name="show" value={s} checked={f.show.includes(s)} />
				{/each}
			</div>
		</fieldset>
		<div class="pair">
			<Select
				label="Tasks"
				name="tasks"
				options={taskOptions}
				value={f.tasks === 'all' ? 'all' : 'mine'}
			/>
			<Select label="Project" name="project" options={projectOptions} value={f.project ?? ''} />
		</div>
		<div class="checks">
			<Checkbox
				label="Show completed tasks and milestones"
				name="done"
				value="1"
				checked={f.done}
			/>
			<Checkbox label="Only events I created or attend" name="mine" value="1" checked={f.mine} />
		</div>
		<div class="filter-actions">
			<Button type="submit">Apply</Button>
			<Button href="/calendar" variant="ghost">Reset</Button>
		</div>
	</form>
</details>

<div class="banners">
	{#if data.loadError}
		<Banner tone="error">The calendar could not be loaded. <a href={href({})}>Retry</a></Banner>
	{/if}
	<Banner
		tone="warning"
		message={data.capped ? 'Some items are not shown; narrow the filters.' : null}
	/>
	<Banner tone="success" message={data.deleted ? 'Event deleted.' : null} />
</div>

{#if grid && f.view !== 'week'}
	<section class="grid-block cal-block" class:auto aria-label="Month" data-dir={dir}>
		<Card flush>
			<div class="scroll-box">
				<div class="month">
					<div class="weekdays" aria-hidden="true">
						{#each ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as w (w)}<span>{w}</span
							>{/each}
					</div>
					<ol class="cells">
						{#each gridDays as day (day.date)}
							<li
								class="cell"
								class:outside={day.date.slice(0, 7) !== month}
								class:today={day.date === today}
							>
								<a
									class="day-link"
									href={href({ view: 'agenda', date: day.date })}
									aria-label="{formatDay(day.date, true)}{day.date === today ? ', today' : ''}, {day
										.items.length} {day.items.length === 1 ? 'item' : 'items'}"
								>
									<span class="num">{Number(day.date.slice(8))}</span>
									<span class="dots" aria-hidden="true">
										{#each day.items.slice(0, MAX_CHIPS) as item (item.key)}
											<span class="dot kind-{item.kind}"></span>
										{/each}
										{#if day.items.length > 0}<span class="count">{day.items.length}</span>{/if}
									</span>
								</a>
								{#if day.items.length > 0}
									<ul class="chips">
										{#each day.items.slice(0, MAX_CHIPS) as item (item.key)}
											<li><Chip {item} day={day.date} {zone} /></li>
										{/each}
									</ul>
									{#if day.items.length > MAX_CHIPS}
										<a class="more" href={href({ view: 'agenda', date: day.date })}
											>+{day.items.length - MAX_CHIPS} more</a
										>
									{/if}
								{/if}
							</li>
						{/each}
					</ol>
				</div>
			</div>
		</Card>
	</section>
{/if}

{#if grid && f.view === 'week'}
	<section class="week-block cal-block" aria-label="Week" data-dir={dir}>
		<nav class="strip" aria-label="Days of the week">
			{#each gridDays as day (day.date)}
				<a
					class="strip-day"
					class:today={day.date === today}
					href={href({ view: 'week', date: day.date })}
					aria-current={selectedDay?.date === day.date ? 'date' : undefined}
					aria-label="{formatDay(day.date, true)}, {day.items.length} {day.items.length === 1
						? 'item'
						: 'items'}"
				>
					<span class="wd">{formatDay(day.date).slice(0, 2)}</span>
					<span class="num">{Number(day.date.slice(8))}</span>
					{#if day.items.length > 0}<span class="mark" aria-hidden="true"></span>{/if}
				</a>
			{/each}
		</nav>
		{#if selectedDay}
			<div class="strip-list">
				<Card title={formatDay(selectedDay.date, true)} level={3}>
					{#if selectedDay.items.length === 0}
						<p class="none">Nothing scheduled.</p>
					{:else}
						<ul class="lines">
							{#each selectedDay.items as item (item.key)}
								<li><ItemLine {item} day={selectedDay.date} {zone} zoneLabel={label} /></li>
							{/each}
						</ul>
					{/if}
				</Card>
			</div>
		{/if}
		<div class="week-cols-box">
			<Card flush>
				<div class="scroll-box">
					<div class="week-cols">
						{#each gridDays as day (day.date)}
							<section class="col" class:today={day.date === today}>
								<h3>{formatDay(day.date)}</h3>
								{#if day.items.length === 0}
									<p class="none">—</p>
								{:else}
									<ul class="chips">
										{#each day.items as item (item.key)}
											<li><Chip {item} day={day.date} {zone} /></li>
										{/each}
									</ul>
								{/if}
							</section>
						{/each}
					</div>
				</div>
			</Card>
		</div>
	</section>
{/if}

{#if data.ranges.agenda}
	<section class="agenda-block cal-block" class:auto aria-label="Agenda" data-dir={dir}>
		{#if agendaDays.length === 0 && !data.loadError}
			<EmptyState
				title="Nothing scheduled"
				description={activeFilters.length ? `Filters: ${activeFilters.join(' · ')}.` : undefined}
				action={{ href: `/calendar/events/new?date=${f.date}`, label: 'Add event' }}
			/>
		{:else}
			<Card flush>
				{#each agendaDays as day (day.date)}
					<section class="agenda-day">
						<h3 class:today={day.date === today}>
							{formatDay(day.date, true)}{day.date === today ? ' · Today' : ''}
						</h3>
						<ul class="lines">
							{#each day.items as item (item.key)}
								<li><ItemLine {item} day={day.date} {zone} zoneLabel={label} /></li>
							{/each}
						</ul>
					</section>
				{/each}
			</Card>
		{/if}
		<p class="next">
			<Button href={href({ view: 'agenda', date: addDays(data.ranges.agenda.to, 1) })}
				>Load next 14 days</Button
			>
		</p>
	</section>
{/if}

<style>
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 12px;
	}
	/* Prev / Today / Next: Kumo's segmented track, every segment a 44 px target. */
	.steps {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border-radius: var(--radius-m);
		background: var(--surface-2);
	}
	.step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 40px;
		padding: 0 12px;
		box-sizing: border-box;
		border-radius: var(--radius-s);
		color: var(--fg);
		font-size: var(--text-sm);
		font-weight: 500;
		text-decoration: none;
		transition: background-color var(--dur-fast) var(--ease);
	}
	.step:hover {
		background: var(--surface);
		box-shadow:
			0 0 0 1px var(--border),
			var(--shadow-1);
	}
	@media (pointer: coarse) {
		.step {
			min-height: 44px;
		}
	}
	.period {
		order: -1;
		flex: 1 1 100%;
		margin: 0;
		color: var(--fg-strong);
		font-size: var(--text-lg);
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	@media (min-width: 768px) {
		.period {
			order: 0;
			flex: 1 1 auto;
			text-align: center;
		}
	}
	.filters {
		margin-bottom: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
		box-shadow: var(--shadow-1);
	}
	.filters summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		padding: 0 14px;
		cursor: pointer;
		color: var(--fg);
		font-size: var(--text-sm);
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.filter-form {
		display: grid;
		gap: 12px;
		padding: 4px 14px 14px;
		border-top: 1px solid var(--border);
	}
	.filter-form fieldset {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	.filter-form legend {
		margin-bottom: 4px;
		color: var(--fg-strong);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.checks {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 20px;
	}
	.pair {
		display: grid;
		gap: 12px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
	}
	.filter-actions {
		display: flex;
		gap: 8px;
	}
	.banners {
		display: grid;
		gap: 8px;
		margin-bottom: 8px;
	}
	.cal-block {
		min-width: 0;
		margin-bottom: 16px;
	}
	/* No `view`: the agenda below 768 px, the month from 768 px up. */
	@media (max-width: 767.98px) {
		.grid-block.auto {
			display: none;
		}
	}
	@media (min-width: 768px) {
		.agenda-block.auto {
			display: none;
		}
	}
	/* Grids scroll inside their own box, never the page. */
	.scroll-box {
		max-width: 100%;
		overflow-x: auto;
		overscroll-behavior-x: contain;
	}
	.weekdays,
	.cells {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
	}
	@media (min-width: 768px) {
		.month {
			min-width: 640px;
		}
	}
	.weekdays {
		background: var(--elevated);
		border-bottom: 1px solid var(--border);
	}
	.weekdays span {
		padding: 8px 4px;
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: 500;
		text-align: center;
	}
	.cells {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.cell {
		display: grid;
		align-content: start;
		gap: 2px;
		min-width: 0;
		min-height: 44px;
		border-top: 1px solid var(--border);
		border-left: 1px solid var(--border);
	}
	.cell:nth-child(-n + 7) {
		border-top: 0;
	}
	.cell:nth-child(7n + 1) {
		border-left: 0;
	}
	.outside {
		background: var(--elevated);
	}
	.outside .num {
		color: var(--subtle);
	}
	.day-link {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		min-height: 44px;
		color: var(--fg);
		font-size: var(--text-sm);
		text-decoration: none;
	}
	.day-link:hover .num {
		color: var(--accent);
	}
	.today .num {
		display: inline-grid;
		place-items: center;
		min-width: 24px;
		height: 24px;
		border-radius: 999px;
		background: var(--brand);
		color: var(--brand-fg);
		font-weight: 600;
	}
	.today .day-link:hover .num {
		color: var(--brand-fg);
	}
	.dots {
		display: flex;
		align-items: center;
		gap: 2px;
		min-height: 8px;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--muted);
	}
	.dot.kind-event {
		background: var(--accent);
	}
	.dot.kind-milestone {
		background: var(--success);
	}
	.dot.kind-timeoff {
		background: var(--warning);
	}
	.count {
		margin-left: 2px;
		color: var(--muted);
		font-size: 10px;
	}
	.chips {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0 4px 4px;
		list-style: none;
		min-width: 0;
	}
	.chips li {
		min-width: 0;
	}
	.more {
		display: inline-flex;
		align-items: center;
		padding: 0 6px 4px;
		color: var(--accent);
		font-size: var(--text-xs);
		font-weight: 500;
	}
	@media (pointer: coarse) {
		.more {
			min-height: 44px;
		}
	}
	@media (max-width: 767.98px) {
		.cell .chips,
		.cell .more {
			display: none;
		}
	}
	@media (min-width: 768px) {
		.cell {
			min-height: 104px;
		}
		.day-link {
			align-items: flex-start;
			justify-content: flex-start;
			min-height: 0;
			padding: 6px 8px 2px;
		}
		.dots {
			display: none;
		}
	}
	/* Week: a 7-day strip and the chosen day's list on phones; seven columns from 768 px. */
	.strip {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 2px;
		margin-bottom: 10px;
		padding: 2px;
		border-radius: var(--radius-m);
		background: var(--surface-2);
	}
	.strip-day {
		display: grid;
		place-items: center;
		min-height: 52px;
		border-radius: var(--radius-s);
		color: var(--fg);
		font-size: var(--text-sm);
		text-decoration: none;
	}
	.strip-day[aria-current='date'] {
		background: var(--surface);
		box-shadow:
			0 0 0 1px var(--border),
			var(--shadow-1);
		font-weight: 600;
	}
	.strip-day.today .num {
		color: var(--accent);
		font-weight: 700;
	}
	.wd {
		color: var(--muted);
		font-size: 11px;
	}
	.mark {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
	}
	.agenda-day h3,
	.col h3 {
		margin: 0 0 4px;
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
	}
	.agenda-day h3.today,
	.col.today h3 {
		color: var(--accent);
	}
	.week-cols {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		min-width: 840px;
	}
	.col {
		min-width: 0;
		padding: 8px;
		border-left: 1px solid var(--border);
	}
	.col:first-child {
		border-left: 0;
	}
	@media (max-width: 767.98px) {
		.week-cols-box {
			display: none;
		}
	}
	@media (min-width: 768px) {
		.strip,
		.strip-list {
			display: none;
		}
	}
	.none {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.lines {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.agenda-day {
		padding: 12px 10px;
		border-top: 1px solid var(--border);
	}
	.agenda-day:first-child {
		border-top: 0;
	}
	.next {
		margin: 12px 0 0;
	}
</style>
