<script lang="ts">
	import { navigating } from '$app/state';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data } = $props();
	const loading = $derived(navigating.to?.route.id === '/(app)/people');
	const q = $derived(data.query);
	const filtered = $derived(Boolean(q.q || q.department || q.status !== 'active'));
	const first = $derived(data.total === 0 ? 0 : (q.page - 1) * data.pageSize + 1);
	const last = $derived(Math.min(q.page * data.pageSize, data.total));
	const departmentOptions = $derived([
		{ value: '', label: 'All departments' },
		...data.departments.map((d) => ({ value: d, label: d }))
	]);
	const STATUS_OPTIONS = [
		{ value: 'active', label: 'Active' },
		{ value: 'terminated', label: 'Former staff' },
		{ value: 'all', label: 'Active and former' },
		{ value: 'deleted', label: 'Deleted' }
	];
	const SORT_OPTIONS = [
		{ value: 'name', label: 'Name' },
		{ value: 'department', label: 'Department' }
	];

	/** The directory URL for another page with the same filters. */
	function pageHref(page: number): string {
		// A one-off string builder, not reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const p = new URLSearchParams();
		if (q.q) p.set('q', q.q);
		if (q.department) p.set('department', q.department);
		if (q.status !== 'active') p.set('status', q.status);
		if (q.sort !== 'name') p.set('sort', q.sort);
		if (page > 1) p.set('page', String(page));
		const s = p.toString();
		return s ? `/people?${s}` : '/people';
	}
</script>

<PageHeader
	title="People"
	description="Everyone in the company: who they are and how to reach them."
>
	{#snippet actions()}
		<Button href="/people/org" variant="ghost">Org chart</Button>
		{#if data.canAudit}<Button href="/hr/audit" variant="ghost">Audit log</Button>{/if}
		{#if data.isHr}
			<form method="POST" action="/hr/export" class="inline">
				<Button type="submit" variant="ghost">Export CSV</Button>
			</form>
			<Button href="/people/new" variant="primary">Add employee</Button>
		{/if}
	{/snippet}
</PageHeader>

<form method="GET" class="filters" role="search" aria-label="Filter people">
	<div class="search">
		<TextField
			label="Search people"
			name="q"
			type="search"
			value={q.q}
			maxlength={50}
			placeholder="Name, title, department, location or e-mail"
			hideLabel
		/>
	</div>
	<Select
		label="Department"
		name="department"
		options={departmentOptions}
		value={q.department ?? ''}
		hideLabel
	/>
	{#if data.isHr}
		<Select label="Status" name="status" options={STATUS_OPTIONS} value={q.status} hideLabel />
	{/if}
	<Select label="Sort by" name="sort" options={SORT_OPTIONS} value={q.sort} hideLabel />
	<div class="filter-actions">
		<Button type="submit">Apply</Button>
		{#if filtered}<Button href="/people" variant="ghost">Clear</Button>{/if}
	</div>
</form>

{#if loading}
	<ul class="rows skeleton" aria-busy="true" aria-label="Loading people">
		{#each [0, 1, 2, 3] as i (i)}<li class="row"><span class="bar"></span></li>{/each}
	</ul>
{:else if data.total === 0 && !filtered}
	{#if data.isHr}
		<EmptyState
			title="No employees yet"
			description="Employee records are separate from accounts: add people, then link their account."
			action={{ href: '/people/new', label: 'Add the first employee' }}
		/>
	{:else}
		<EmptyState
			title="No employees yet"
			description="HR adds employee records; they show up here."
		/>
	{/if}
{:else if data.total === 0}
	<EmptyState title="No employees match" description="Try another search or filter.">
		<Button href="/people" variant="ghost">Clear filters</Button>
	</EmptyState>
{:else}
	<p class="count" aria-live="polite">Showing {first}–{last} of {data.total}</p>
	<ul class="rows">
		<li class="row head" aria-hidden="true">
			<span>Name</span><span>Title</span><span>Department</span><span>Location</span><span
				>Manager</span
			><span>Contact</span>
		</li>
		{#each data.rows as person (person.id)}
			<li class="row">
				<span class="name">
					<a href="/people/{person.id}"
						>{person.fullName}{#if person.preferredName}
							<span class="pref">({person.preferredName})</span>{/if}</a
					>
					{#if person.deletedAt !== null}<Badge tone="danger">Deleted</Badge>
					{:else if person.status === 'terminated'}<Badge tone="warning">Former</Badge>{/if}
				</span>
				<span class="title">{person.jobTitle ?? ''}</span>
				<span class="dept">{person.department ?? ''}</span>
				<span class="loc">{person.location ?? ''}</span>
				<span class="mgr"
					>{#if person.managerName}<span class="label">Reports to</span>
						{person.managerName}{/if}</span
				>
				<span class="contact">
					{#if person.workEmail}<span class="email">{person.workEmail}</span>{/if}
					{#if person.workPhone}<span>{person.workPhone}</span>{/if}
				</span>
			</li>
		{/each}
	</ul>
	{#if data.total > data.pageSize}
		<nav class="pager" aria-label="Pages">
			{#if q.page > 1}<Button href={pageHref(q.page - 1)} variant="ghost">Previous</Button>{/if}
			{#if last < data.total}<Button href={pageHref(q.page + 1)} variant="ghost">Next</Button>{/if}
		</nav>
	{/if}
{/if}

<style>
	.inline {
		display: contents;
	}
	.filters {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
		margin-bottom: 16px;
	}
	.filter-actions {
		display: flex;
		gap: 8px;
	}
	@media (min-width: 768px) {
		.filters {
			grid-template-columns: minmax(0, 2fr) repeat(auto-fit, minmax(140px, 1fr));
			align-items: end;
		}
	}
	.count {
		margin: 0 0 8px;
		color: var(--muted);
		font-size: 13px;
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
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 2px 12px;
		padding: 12px 14px;
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.head {
		display: none;
	}
	.name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		font-weight: 500;
	}
	.name a {
		color: var(--fg);
		text-decoration: none;
	}
	.name a::after {
		content: '';
		position: absolute;
		inset: 0;
	}
	.name a:hover {
		text-decoration: underline;
	}
	@media (pointer: coarse) {
		.name a {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}
	}
	.pref {
		color: var(--muted);
		font-weight: 400;
	}
	.title,
	.dept,
	.loc,
	.mgr,
	.contact {
		color: var(--muted);
	}
	.contact {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 12px;
	}
	.label {
		color: var(--muted);
	}
	.pager {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
	}
	.skeleton .bar {
		display: block;
		height: 16px;
		width: 60%;
		border-radius: var(--radius-s);
		background: var(--surface-3);
	}
	@media (min-width: 1000px) {
		.row {
			grid-template-columns: 1.4fr 1.1fr 0.9fr 0.8fr 1fr 1.3fr;
			align-items: center;
		}
		.head {
			display: grid;
			color: var(--muted);
			font-size: 12px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.03em;
		}
		.mgr .label {
			display: none;
		}
		.contact {
			display: grid;
		}
	}
</style>
