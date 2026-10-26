<script lang="ts">
	import { page } from '$app/state';
	import { HR_AUDIT_ACTIONS, HR_AUDIT_ACTION_LABELS, type HrAuditAction } from '#lib/shared/enums';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data } = $props();
	const actionLabel = (a: string) => HR_AUDIT_ACTION_LABELS[a as HrAuditAction] ?? a;
	const actorOptions = $derived([
		{ value: '', label: 'Anyone' },
		...data.actors.map((a) => ({ value: a.id, label: a.name }))
	]);
	const employeeOptions = $derived([
		{ value: '', label: 'Any employee' },
		...data.employees.map((e) => ({ value: e.id, label: e.fullName }))
	]);
	const actionOptions = [
		{ value: '', label: 'Any action' },
		...HR_AUDIT_ACTIONS.map((a) => ({ value: a, label: HR_AUDIT_ACTION_LABELS[a] }))
	];
	const filtered = $derived(Object.values(data.filters).some(Boolean));
	function nextHref(cursor: string): string {
		// A one-off string builder, not reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const p = new URLSearchParams(page.url.search);
		p.set('before', cursor);
		return `/hr/audit?${p.toString()}`;
	}
</script>

<PageHeader
	title="HR audit log"
	description="Who viewed or changed employee data, and when. Field names only, never values."
>
	{#snippet actions()}
		<Button href="/people" variant="ghost">People</Button>
	{/snippet}
</PageHeader>

<form method="GET" class="filters" aria-label="Filter the audit log">
	<Select label="Actor" name="actor" options={actorOptions} value={data.filters.actor} />
	<Select
		label="Employee"
		name="employee"
		options={employeeOptions}
		value={data.filters.employee}
	/>
	<Select label="Action" name="action" options={actionOptions} value={data.filters.action} />
	<TextField label="From" name="from" type="date" value={data.filters.from} />
	<TextField label="To" name="to" type="date" value={data.filters.to} />
	<div class="filter-actions">
		<Button type="submit">Apply</Button>
		{#if filtered || data.paged}<Button href="/hr/audit" variant="ghost">Clear</Button>{/if}
	</div>
</form>

{#if data.rows.length === 0}
	<EmptyState title="No activity recorded" description="Matching audit entries show up here." />
{:else}
	<ul class="rows">
		{#each data.rows as row (row.id)}
			<li class="row" class:self={row.self}>
				<span class="when"
					><LocalTime at={row.at} withTime />{#if row.self}
						<span class="self-badge" title="The actor acted on their own record">Self</span
						>{/if}</span
				>
				<span class="what"
					><strong>{actionLabel(row.action)}</strong>
					{#if row.employeeName}<span> · {row.employeeName}</span>
					{:else if row.employeeHidden}<span class="muted">
							· an employee record you cannot open</span
						>{/if}
					{#if row.userName}<span> · account {row.userName}</span>{/if}</span
				>
				<span class="who">by {row.actorName ?? 'a former user'}</span>
				{#if row.fields.length || row.detail}
					<span class="fields"
						>{row.fields.join(', ')}{#if row.detail}{row.fields.length
								? ' · '
								: ''}{row.detail}{/if}</span
					>
				{/if}
			</li>
		{/each}
	</ul>
	{#if data.next}
		<nav class="pager" aria-label="Pages">
			<Button href={nextHref(data.next)} variant="ghost">Older entries</Button>
		</nav>
	{/if}
{/if}

<style>
	.filters {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
		margin-bottom: 16px;
	}
	@media (min-width: 640px) {
		.filters {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (min-width: 1000px) {
		.filters {
			grid-template-columns: repeat(5, minmax(0, 1fr)) auto;
			align-items: end;
		}
	}
	.filter-actions {
		display: flex;
		gap: 8px;
		align-items: end;
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.row {
		display: grid;
		gap: 2px;
		padding: 10px 14px;
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.row.self {
		box-shadow: inset 3px 0 0 var(--warning);
		background: var(--warning-soft);
	}
	.self-badge {
		margin-left: 6px;
		padding: 0 6px;
		border-radius: 999px;
		background: var(--warning);
		color: var(--surface);
		font-size: 11px;
		font-weight: 600;
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.when,
	.who,
	.muted,
	.fields {
		color: var(--muted);
		font-size: 13px;
	}
	.fields {
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.pager {
		display: flex;
		justify-content: flex-end;
		margin-top: 12px;
	}
</style>
