<script lang="ts">
	import { LEAVE_STATUSES, LEAVE_STATUS_LABELS } from '#lib/shared/enums';
	import { formatDays } from '#lib/shared/time-off';
	import RequestList from '#lib/ui/time-off/RequestList.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';

	let { data, form } = $props();
	const f = $derived((form ?? {}) as Record<string, unknown>);
	const employeeOptions = $derived([
		{ value: '', label: data.isHr ? 'Everyone' : 'All my reports' },
		...data.members.map((m) => ({ value: m.id, label: m.fullName }))
	]);
	const statusOptions = [
		{ value: '', label: 'Any status' },
		...LEAVE_STATUSES.map((s) => ({ value: s, label: LEAVE_STATUS_LABELS[s] }))
	];
	const yearOptions = $derived(data.years.map((y) => ({ value: String(y), label: String(y) })));
</script>

<PageHeader
	title="Team time off"
	description={data.isHr
		? 'Everyone’s balances and requests.'
		: 'Your direct reports’ balances and requests.'}
/>

<div class="stack">
	<Banner tone="success" message={f.canceled as string | undefined} />
	<Banner tone="error" message={f.error as string | undefined} />

	<form method="GET" class="filters" aria-label="Filter team time off">
		<Select
			label="Employee"
			name="employee"
			options={employeeOptions}
			value={data.filters.employee}
		/>
		<Select label="Status" name="status" options={statusOptions} value={data.filters.status} />
		<Select label="Year" name="year" options={yearOptions} value={data.filters.year} />
		<div class="filter-actions"><Button type="submit">Apply</Button></div>
	</form>

	<section aria-labelledby="bal-h">
		<h2 id="bal-h">Balances {data.year}</h2>
		{#if data.balances.length === 0}
			<EmptyState
				title="No balances"
				description="Nobody here has leave with a yearly balance yet."
			/>
		{:else}
			<ul class="balances" aria-label="Balances {data.year}">
				{#each data.balances as b (`${b.employeeId}:${b.typeId}`)}
					<li>
						<span class="who">{b.employeeName} · {b.typeName}</span>
						<span class="figures"
							>{formatDays(b.available)} available · {formatDays(b.entitled)} entitled · {formatDays(
								b.used
							)} used · {formatDays(b.pending)} pending</span
						>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section aria-labelledby="req-h">
		<h2 id="req-h">Requests {data.year}</h2>
		{#if data.requests.length === 0}
			<EmptyState title="No requests yet" description="Matching requests show up here." />
		{:else}
			<RequestList
				requests={data.requests}
				cancelAction={data.isHr ? '?/cancel' : undefined}
				label="Team requests"
			/>
		{/if}
	</section>
</div>

<style>
	.stack {
		display: grid;
		gap: 18px;
		min-width: 0;
	}
	h2 {
		margin: 0 0 10px;
		font-size: 16px;
		font-weight: 600;
	}
	.filters {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
	}
	@media (min-width: 640px) {
		.filters {
			grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
			align-items: end;
		}
	}
	.filter-actions {
		display: flex;
		align-items: end;
	}
	.balances {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.balances li {
		display: grid;
		gap: 2px;
		padding: 10px 14px;
		font-size: 14px;
	}
	.balances li + li {
		border-top: 1px solid var(--border);
	}
	.figures {
		color: var(--muted);
		font-size: 13px;
	}
</style>
