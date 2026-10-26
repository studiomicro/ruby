<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatDay, utcToZoned } from '#lib/shared/calendar';
	import ReminderPanel from '#lib/ui/calendar/ReminderPanel.svelte';
	import { timeRange } from '#lib/ui/calendar/when';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Card from '#lib/ui/kit/Card.svelte';
	import Markdown from '#lib/ui/kit/Markdown.svelte';

	let { data, form } = $props();

	const ev = $derived(data.ev);
	const zone = $derived(data.clock.zone);
	const label = $derived(data.clock.zoneLabel);
	const REPEAT: Record<string, string> = { daily: 'day', weekly: 'week', monthly: 'month' };

	/** "Mon 2 Nov 2026, 14:00–15:30 WIB" or "Mon 2 Nov 2026 – Wed 4 Nov 2026" (all day). */
	const when = $derived.by(() => {
		const o = data.occurrence;
		if (ev.allDay) {
			const start = o?.onDate ?? ev.startOn ?? '';
			const end = o?.endDate ?? ev.endOn ?? start;
			return start === end
				? `${formatDay(start, true)}, all day`
				: `${formatDay(start, true)} – ${formatDay(end, true)}, all day`;
		}
		const start = o?.startAt ?? ev.startAt ?? 0;
		const end = o?.endAt ?? ev.endAt ?? 0;
		const s = utcToZoned(start, zone);
		const e = utcToZoned(end - 1, zone);
		return s.date === e.date
			? `${formatDay(s.date, true)}, ${timeRange(start, end, zone)} ${label}`
			: `${formatDay(s.date, true)} ${s.time} – ${formatDay(e.date, true)} ${utcToZoned(end, zone).time} ${label}`;
	});
	const repeats = $derived(
		ev.recFreq
			? `Repeats every ${ev.recInterval > 1 ? `${ev.recInterval} ` : ''}${REPEAT[ev.recFreq]}${ev.recInterval > 1 ? 's' : ''} until ${formatDay(ev.recUntilOn ?? '', true)}`
			: null
	);
	let removing = $state<'all' | 'one' | null>(null);
	const removeError = $derived(form && 'removeError' in form ? form.removeError : null);
	const reminderResult = $derived(form && 'reminder' in form ? form.reminder : null);
</script>

<svelte:head><title>{ev.title} · Ruby</title></svelte:head>

<header class="head">
	<p class="crumb"><a href="/calendar">Calendar</a></p>
	<h1>{ev.title}</h1>
	<div class="chips">
		{#if ev.visibility === 'private'}<Badge tone="warning">Private</Badge>{/if}
		{#if ev.projectKey}<Badge>{ev.projectKey}</Badge>{/if}
	</div>
</header>

<div class="banners">
	<Banner
		tone="success"
		message={data.created ? 'Event created.' : data.saved ? 'Event saved.' : null}
	/>
	{#if data.occurrenceRemoved}<Banner tone="warning" message="This occurrence was removed." />{/if}
</div>

<div class="layout">
	<section class="main" aria-label="Event">
		<Card>
			<div class="body">
				<dl>
					<dt>When</dt>
					<dd>{when}</dd>
					{#if repeats}<dt>Repeats</dt>
						<dd>{repeats}</dd>{/if}
					{#if ev.location}<dt>Where</dt>
						<dd class="text">{ev.location}</dd>{/if}
					<dt>Created by</dt>
					<dd>{ev.createdByName ?? 'a former user'}</dd>
					<dt>Attendees</dt>
					<dd>
						{#if ev.attendees.length === 0}None{:else}
							<ul class="people">
								{#each ev.attendees as a (a.id)}
									<li>{a.name}{a.active ? '' : ' (inactive)'}</li>
								{/each}
							</ul>
						{/if}
					</dd>
				</dl>
				<div class="description">
					<Markdown source={ev.description} empty="No description." />
				</div>
				{#if data.canManage}
					<footer class="foot">
						<Button href="/calendar/events/{ev.id}/edit">Edit{ev.recFreq ? ' series' : ''}</Button>
					</footer>
				{/if}
			</div>
		</Card>
	</section>

	<aside class="side" aria-label="Reminders and actions">
		<ReminderPanel
			panel={data.reminders}
			result={reminderResult}
			{zone}
			zoneLabel={label}
			today={data.clock.today}
		/>

		{#if data.canManage}
			<Card title="Delete" description="There is no undo here.">
				<div class="danger">
					<Banner tone="error" message={removeError} />
					{#if ev.recFreq && data.on && !data.occurrenceRemoved}
						<form
							method="POST"
							action="?/removeOccurrence"
							use:enhance={() => {
								removing = 'one';
								return async ({ update }) => {
									await update();
									removing = null;
								};
							}}
						>
							<input type="hidden" name="on" value={data.on} />
							<Button
								type="submit"
								variant="danger"
								loading={removing === 'one'}
								loadingLabel="Deleting…">Delete this occurrence ({formatDay(data.on)})</Button
							>
						</form>
					{/if}
					<form
						method="POST"
						action="?/remove"
						class="confirm-form"
						use:enhance={() => {
							removing = 'all';
							return async ({ update }) => {
								await update();
								removing = null;
							};
						}}
					>
						<label class="confirm"
							><input type="checkbox" name="confirm" value="yes" required /> Yes, delete {ev.recFreq
								? 'the whole series'
								: 'this event'}</label
						>
						<Button
							type="submit"
							variant="danger"
							loading={removing === 'all'}
							loadingLabel="Deleting…">{ev.recFreq ? 'Delete whole series' : 'Delete event'}</Button
						>
					</form>
				</div>
			</Card>
		{/if}
	</aside>
</div>

<style>
	.head {
		display: grid;
		gap: 6px;
		margin-bottom: 16px;
		min-width: 0;
	}
	.crumb {
		margin: 0;
		font-size: var(--text-sm);
	}
	.crumb a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--muted);
	}
	h1 {
		margin: 0;
		color: var(--fg-strong);
		font-size: var(--text-2xl);
		letter-spacing: -0.02em;
		line-height: 1.3;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	@media (max-width: 767.98px) {
		h1 {
			font-size: 22px;
		}
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.banners {
		display: grid;
		gap: 8px;
		margin-bottom: 8px;
	}
	.layout {
		display: grid;
		gap: 20px;
		grid-template-columns: minmax(0, 1fr);
	}
	@media (min-width: 900px) {
		.layout {
			grid-template-columns: minmax(0, 1fr) 300px;
			align-items: start;
		}
	}
	.main {
		min-width: 0;
	}
	.body {
		display: grid;
		gap: 16px;
	}
	dl {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 8px 12px;
		margin: 0;
		font-size: var(--text-base);
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.text {
		white-space: pre-wrap;
	}
	.people {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.foot {
		display: flex;
		gap: 8px;
	}
	.side {
		display: grid;
		gap: 14px;
		min-width: 0;
	}
	.danger {
		display: grid;
		gap: 10px;
	}
	.confirm-form {
		display: grid;
		gap: 8px;
	}
	.confirm {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		font-size: var(--text-base);
	}
	.confirm input {
		width: 18px;
		height: 18px;
		accent-color: var(--danger);
	}
</style>
