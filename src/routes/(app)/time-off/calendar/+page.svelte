<script lang="ts">
	import { HALF_DAY_LABELS } from '#lib/shared/enums';
	import { WEEKDAY_NAMES } from '#lib/shared/time-off';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';

	let { data } = $props();
	const monthLabel = $derived(
		new Date(`${data.month}-01T00:00:00Z`).toLocaleDateString('en-US', {
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		})
	);
	const days = $derived(data.weeks.flat().filter((d) => d !== null));
	const anyoneOut = $derived(days.some((d) => d.out.length > 0));
	const agenda = $derived(days.filter((d) => d.out.length > 0 || d.holiday));
	const partLabel = (part: 'none' | 'am' | 'pm') => (part === 'none' ? '' : ` (${part})`);
</script>

<PageHeader title="Team calendar" description="Approved leave and holidays. Names only.">
	{#snippet actions()}
		{#if data.prev}<Button href="?month={data.prev}" variant="ghost">Previous</Button>{/if}
		{#if data.month !== data.current}<Button href="?month={data.current}" variant="ghost"
				>This month</Button
			>{/if}
		{#if data.next}<Button href="?month={data.next}" variant="ghost">Next</Button>{/if}
	{/snippet}
</PageHeader>

<h2 class="month">{monthLabel}</h2>
<Banner
	tone="info"
	message={data.truncated ? 'This month has more leave than can be shown at once.' : null}
/>

<div class="grid-box" role="region" aria-label="Leave calendar" tabindex="-1">
	<table class="cal-grid">
		<thead>
			<tr>
				{#each WEEKDAY_NAMES as name (name)}<th scope="col" abbr={name}>{name.slice(0, 3)}</th
					>{/each}
			</tr>
		</thead>
		<tbody>
			{#each data.weeks as week, w (w)}
				<tr>
					{#each week as day, i (i)}
						{#if day}
							<td class:today={day.date === data.today} class:holiday={day.holiday}>
								<span class="date">{Number(day.date.slice(8))}</span>
								{#if day.holiday}<span class="hol">{day.holiday}</span>{/if}
								{#each day.out as person, p (p)}
									<span class="out">{person.name}{partLabel(person.part)}</span>
								{/each}
							</td>
						{:else}
							<td class="blank"></td>
						{/if}
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<section class="agenda" aria-labelledby="agenda-h">
	<h2 id="agenda-h">Day by day</h2>
	{#if agenda.length === 0}
		<EmptyState title="Nobody is out" description="No approved leave or holidays this month." />
	{:else}
		<ul>
			{#each agenda as day (day.date)}
				<li>
					<strong>{day.date}</strong>
					{#if day.holiday}<span class="hol">{day.holiday}</span>{/if}
					{#if day.out.length}
						<span
							>{day.out
								.map((p) => `${p.name}${p.part === 'none' ? '' : ` (${HALF_DAY_LABELS[p.part]})`}`)
								.join(', ')}</span
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if !anyoneOut && agenda.length > 0}<p class="muted">Nobody is out this month.</p>{/if}
</section>

<style>
	.month {
		margin: 0 0 10px;
		font-size: 16px;
		font-weight: 600;
	}
	.grid-box {
		max-width: 100%;
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.cal-grid {
		width: 100%;
		min-width: 640px;
		border-collapse: collapse;
		table-layout: fixed;
	}
	th {
		padding: 6px;
		border-bottom: 1px solid var(--border);
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		text-align: left;
	}
	td {
		height: 78px;
		padding: 4px 6px;
		border-top: 1px solid var(--border);
		border-left: 1px solid var(--border);
		vertical-align: top;
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	td:first-child {
		border-left: 0;
	}
	td.blank {
		background: var(--surface-2);
	}
	td.today .date {
		background: var(--accent);
		color: var(--accent-fg);
	}
	td.holiday {
		background: var(--warning-soft);
	}
	.date {
		display: inline-block;
		min-width: 20px;
		border-radius: 999px;
		font-weight: 600;
		text-align: center;
	}
	.hol {
		display: block;
		color: var(--warning);
		font-weight: 500;
	}
	.out {
		display: block;
		margin-top: 2px;
		padding: 0 4px;
		border-radius: 4px;
		background: var(--accent-soft);
		color: var(--fg);
	}
	.agenda {
		margin-top: 20px;
	}
	.agenda h2 {
		margin: 0 0 10px;
		font-size: 16px;
		font-weight: 600;
	}
	.agenda ul {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.agenda li {
		display: grid;
		gap: 2px;
		padding: 10px 14px;
		font-size: 14px;
	}
	.agenda li + li {
		border-top: 1px solid var(--border);
	}
	.muted {
		color: var(--muted);
		font-size: 13px;
	}
</style>
