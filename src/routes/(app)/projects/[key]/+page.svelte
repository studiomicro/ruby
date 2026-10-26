<script lang="ts">
	import { navigating, page } from '$app/state';
	import type { TaskStatus } from '#lib/shared/enums';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import Board from '#lib/ui/tasks/Board.svelte';
	import FilterBar from '#lib/ui/tasks/FilterBar.svelte';
	import TaskTable from '#lib/ui/tasks/TaskTable.svelte';
	import { actionUrl, moveActionUrl, statusListUrl, withParams } from '#lib/ui/tasks/links';
	import { SvelteSet } from 'svelte/reactivity';
	import BulkBar from '#lib/ui/pm/BulkBar.svelte';
	import ViewPicker from '#lib/ui/pm/ViewPicker.svelte';
	import { answerFor } from '#lib/ui/pm/answer';

	let { data, form } = $props();
	const base = $derived(`/projects/${data.project.key}`);
	const archived = $derived(data.project.status === 'archived');
	const filtered = $derived(
		data.filters.statuses.length > 0 ||
			data.filters.priorities.length > 0 ||
			data.filters.assignee !== 'any' ||
			data.filters.labels.length > 0 ||
			data.filters.milestone !== 'any'
	);
	/** Loading this same page with other filters, sort or view: show placeholders instead of stale rows. */
	const loading = $derived(navigating.to?.url.pathname === page.url.pathname);

	/** `?deleted=OPS-3` after a delete redirect: shown only when it looks like a task reference. */
	const deleted = $derived.by(() => {
		const ref = page.url.searchParams.get('deleted') ?? '';
		return /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/.test(ref) ? ref : null;
	});
	const moveAction = $derived(moveActionUrl(page.url.search));
	const link = (changes: Record<string, string | null>) =>
		withParams(base, page.url.search, changes);
	const moreHref = (status: TaskStatus) => statusListUrl(base, status, data.filters);

	const list = $derived(data.list);
	const first = $derived(list && list.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0);
	const last = $derived(list ? Math.min(data.page * data.pageSize, list.total) : 0);
	const boardEmpty = $derived(data.board?.every((c) => c.count === 0) ?? false);

	// RB-08: the rows selected for bulk edit (this page only; ids no longer shown are dropped).
	const selected = new SvelteSet<string>();
	$effect(() => {
		const shown = new Set(list?.rows.map((r) => r.id) ?? []);
		for (const id of [...selected]) if (!shown.has(id)) selected.delete(id);
	});
	const pmAction = (action: string) => actionUrl(page.url.search, action);
	const viewQuery = $derived(page.url.searchParams.toString());
</script>

<div class="toolbar">
	<nav class="views" aria-label="View">
		<a
			href={link({ view: null, page: null })}
			aria-current={data.view === 'list' ? 'page' : undefined}>List</a
		>
		<a
			href={link({ view: 'board', page: null, sort: null, dir: null })}
			aria-current={data.view === 'board' ? 'page' : undefined}>Board</a
		>
	</nav>
	{#if !archived}
		<Button href="{base}/tasks/new" variant="primary">New task</Button>
	{/if}
</div>

<FilterBar
	action={base}
	view={data.view}
	filters={data.filters}
	sort={data.sort}
	users={data.users}
	labels={data.labels}
	teamLabels={data.teamLabels}
	milestones={data.milestones}
/>

<ViewPicker
	{base}
	kind={data.view}
	query={viewQuery}
	views={data.views}
	{archived}
	answer={answerFor(form, 'views')}
	actionFor={pmAction}
/>

<Banner tone="success" message={deleted ? `Deleted ${deleted}.` : null} />
<Banner tone="error" message={form?.moveError} />

{#if loading}
	<div class="skeleton" aria-busy="true" aria-label="Loading tasks">
		{#each [0, 1, 2, 3] as i (i)}<span class="bar"></span>{/each}
	</div>
{:else if data.view === 'board' && data.board}
	{#if boardEmpty && !filtered}
		<p class="hint">No tasks yet — create the first one with “New task” or a column’s +.</p>
	{:else if boardEmpty}
		<p class="hint">No tasks match these filters. <a href="{base}?view=board">Clear filters</a></p>
	{/if}
	<Board
		board={data.board}
		projectKey={data.project.key}
		{archived}
		today={data.today}
		{moveAction}
		{moreHref}
		settings={data.columns}
	/>
{:else if list}
	{#if list.total === 0 && !filtered}
		<EmptyState
			title="No tasks yet — create the first one"
			description="Tasks get a number in this project, like {data.project.key}-1."
			action={archived ? undefined : { href: `${base}/tasks/new`, label: 'New task' }}
		/>
	{:else if list.rows.length === 0}
		<EmptyState title="No tasks match these filters">
			<Button href={base}>Clear filters</Button>
		</EmptyState>
	{:else}
		{#if !archived}
			<BulkBar
				id="bulk-form"
				action={pmAction('bulk')}
				selectedCount={selected.size}
				pageCount={list.rows.length}
				onselectall={(checked) => {
					selected.clear();
					if (checked) for (const r of list.rows) selected.add(r.id);
				}}
				oncleared={() => selected.clear()}
				users={data.users}
				milestones={data.milestones}
				labels={data.labels}
				teamLabels={data.teamLabels}
				answer={answerFor(form, 'bulk')}
			/>
		{/if}
		<TaskTable
			rows={list.rows}
			projectKey={data.project.key}
			today={data.today}
			selectForm={archived ? undefined : 'bulk-form'}
			{selected}
			onselect={(id, checked) => (checked ? selected.add(id) : selected.delete(id))}
		/>
		{#if selected.size > 0}
			<div class="selection-bar">
				<span>{selected.size} selected</span>
				<Button href="#bulk-form-panel" size="sm" variant="primary">Edit selected</Button>
			</div>
		{/if}
		<nav class="pager" aria-label="Pages">
			<span class="showing">Showing {first}–{last} of {list.total}</span>
			<span class="pages">
				{#if data.page > 1}
					<Button
						href={link({ page: data.page - 1 === 1 ? null : String(data.page - 1) })}
						size="sm">Previous</Button
					>
				{/if}
				{#if last < list.total}
					<Button href={link({ page: String(data.page + 1) })} size="sm">Next</Button>
				{/if}
			</span>
		</nav>
	{/if}
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
	.views {
		display: inline-flex;
		padding: 3px;
		border-radius: var(--radius-m);
		background: var(--surface-2);
	}
	.views a {
		display: inline-flex;
		align-items: center;
		min-height: 30px;
		padding: 0 12px;
		border-radius: var(--radius-s);
		color: var(--muted);
		font-size: 13px;
		font-weight: 500;
		text-decoration: none;
	}
	@media (pointer: coarse) {
		.views a {
			min-height: 44px;
		}
	}
	.views a[aria-current='page'] {
		background: var(--surface);
		color: var(--fg);
		box-shadow: var(--shadow-1);
	}
	.hint {
		margin: 0 0 12px;
		color: var(--muted);
		font-size: 14px;
	}
	.hint a {
		color: var(--accent);
	}
	.pager {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: 12px;
		font-size: 13px;
		color: var(--muted);
	}
	.pages {
		display: flex;
		gap: 8px;
	}
	.selection-bar {
		position: sticky;
		z-index: 5;
		bottom: calc(var(--tabbar-h) + var(--sai-bottom) + 8px);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: 10px;
		padding: 8px 8px 8px 14px;
		border: 1px solid var(--accent);
		border-radius: var(--radius-l);
		background: var(--surface);
		box-shadow: var(--shadow-2);
		font-size: 14px;
		font-weight: 500;
	}
	@media (min-width: 768px) {
		.selection-bar {
			bottom: calc(16px + var(--sai-bottom));
		}
	}
	.skeleton {
		display: grid;
		gap: 8px;
	}
	.bar {
		height: 44px;
		border-radius: var(--radius-m);
		background: var(--surface-2);
	}
</style>
