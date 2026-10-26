<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { navigating, page } from '$app/state';
	import {
		TASK_PRIORITY_LABELS,
		TASK_STATUS_LABELS,
		TASK_TYPE_LABELS,
		type TaskPriority,
		type TaskStatus,
		type TaskType
	} from '#lib/shared/enums';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Dialog from '#lib/ui/kit/Dialog.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import Icon from '#lib/ui/kit/Icon.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import { showToast } from '#lib/ui/kit/toast.svelte';
	import IssueFilters from '#lib/ui/issues/IssueFilters.svelte';
	import IssueTable from '#lib/ui/issues/IssueTable.svelte';
	import { hiddenParams, issuesAction, issuesPage, withoutFilter } from '#lib/ui/issues/links';
	import { answerFor } from '#lib/ui/pm/answer';
	import BulkBar from '#lib/ui/pm/BulkBar.svelte';
	import ViewPicker from '#lib/ui/pm/ViewPicker.svelte';

	let { data, form } = $props();

	let mounted = $state(false);
	onMount(() => (mounted = true));
	let sheetOpen = $state(false);

	/** Loading this page with other filters, sort or page: placeholders instead of stale rows. */
	const loading = $derived(navigating.to?.url.pathname === '/issues');
	const search = $derived(page.url.search);
	const f = $derived(data.filters);

	const totalLabel = $derived(
		data.total >= data.countCap ? '10,000+' : data.total.toLocaleString('en-US')
	);
	const first = $derived(data.rows.length > 0 ? (data.page - 1) * data.pageSize + 1 : 0);
	const last = $derived((data.page - 1) * data.pageSize + data.rows.length);
	const hasNext = $derived(
		data.rows.length === data.pageSize && last < data.total && data.page < 200
	);

	// Bulk selection: this page's rows only (ids no longer shown are dropped).
	const selected = new SvelteSet<string>();
	$effect(() => {
		const shown = new Set(data.rows.map((r) => r.id));
		for (const id of [...selected]) if (!shown.has(id)) selected.delete(id);
	});
	const selectable = $derived(data.rows.filter((r) => !r.projectArchived));

	const bulkAnswer = $derived(answerFor(form, 'bulk'));
	// The server confirmed the write: a toast as well as the bar's own message.
	$effect(() => {
		const answer = bulkAnswer;
		// untrack: showToast reads the toast list, which must not make this effect re-run.
		if (answer?.ok) untrack(() => showToast(answer.message));
	});

	const userName = (id: string) => data.options.users.find((u) => u.id === id)?.name ?? 'Someone';
	const labelName = (id: string) =>
		[...data.options.teamLabels, ...data.options.projectLabels].find((l) => l.id === id)?.name ??
		'Label';
	const person = (p: typeof f.assignee) =>
		p === 'any' ? '' : p === 'me' ? 'Me' : p === 'none' ? 'Unassigned' : userName(p.userId);
	const range = (from: string | null, to: string | null) =>
		from && to ? `${from} – ${to}` : from ? `from ${from}` : `until ${to}`;

	/** The active filters as removable chips (each one a link without that value). */
	const chips = $derived.by(() => {
		const out: { key: string; text: string; href: string }[] = [];
		const each = (key: string, values: string[], text: (v: string) => string) => {
			for (const v of values)
				out.push({ key: `${key}:${v}`, text: text(v), href: withoutFilter(search, key, v) });
		};
		each('type', f.types, (v) => TASK_TYPE_LABELS[v as TaskType]);
		each('status', f.statuses, (v) => TASK_STATUS_LABELS[v as TaskStatus]);
		each('priority', f.priorities, (v) => TASK_PRIORITY_LABELS[v as TaskPriority]);
		each('project', f.projects, (v) => `Project ${v}`);
		each('label', f.labels, (v) => `Label ${labelName(v)}`);
		const single = (key: string, text: string) =>
			out.push({ key, text, href: withoutFilter(search, key) });
		if (f.assignee !== 'any') single('assignee', `Assignee: ${person(f.assignee)}`);
		if (f.reporter !== 'any') single('reporter', `Reporter: ${person(f.reporter)}`);
		const m = f.milestone;
		if (m === 'none') single('milestone', 'No milestone');
		else if (m !== 'any')
			single(
				'milestone',
				`Milestone ${data.options.milestones.find((x) => x.id === m.id)?.name ?? ''}`
			);
		if (f.createdFrom || f.createdTo) {
			out.push({
				key: 'created',
				text: `Created ${range(f.createdFrom, f.createdTo)}`,
				href: withoutFilter(
					new URL(withoutFilter(search, 'created_from'), page.url.origin).search,
					'created_to'
				)
			});
		}
		if (f.updatedFrom || f.updatedTo) {
			out.push({
				key: 'updated',
				text: `Updated ${range(f.updatedFrom, f.updatedTo)}`,
				href: withoutFilter(
					new URL(withoutFilter(search, 'updated_from'), page.url.origin).search,
					'updated_to'
				)
			});
		}
		if (f.archived) single('archived', 'Including archived projects');
		return out;
	});

	const SORTS = [
		{ value: 'updated', label: 'Last updated' },
		{ value: 'created', label: 'Created' },
		{ value: 'priority', label: 'Priority' },
		{ value: 'due', label: 'Due date' }
	];
	const DIRS = [
		{ value: 'desc', label: 'Descending' },
		{ value: 'asc', label: 'Ascending' }
	];
	const sortHidden = $derived(hiddenParams(search, ['sort', 'dir']));
	const autoSubmit = (event: Event & { currentTarget: HTMLSelectElement }) =>
		event.currentTarget.form?.requestSubmit();
</script>

<PageHeader title="Issues" description="Every task of every project, in one list.">
	{#snippet actions()}
		<Button href="/issues/new" variant="primary">Report an issue</Button>
	{/snippet}
</PageHeader>

<div class="toolbar">
	{#if mounted}
		<span class="sheet-open">
			<Button onclick={() => (sheetOpen = true)}
				>Filters{data.active > 0 ? ` (${data.active})` : ''}</Button
			>
		</span>
	{/if}
	<form method="GET" action="/issues" class="sort">
		{#each sortHidden as [name, value], i (i)}<input type="hidden" {name} {value} />{/each}
		<Select
			label="Sort by"
			name="sort"
			options={SORTS}
			value={data.sort.sort}
			onchange={autoSubmit}
		/>
		<Select label="Order" name="dir" options={DIRS} value={data.sort.dir} onchange={autoSubmit} />
		<noscript><Button type="submit" size="sm">Sort</Button></noscript>
	</form>
	<a class="text-search" href="/search">Search text instead</a>
</div>

<details class="inline-filters" class:phone-hidden={mounted}>
	<summary
		>Filters{#if data.active > 0}<span class="count"> ({data.active} active)</span>{/if}</summary
	>
	<div class="inline-body">
		<IssueFilters filters={data.filters} sort={data.sort} options={data.options} />
	</div>
</details>

{#if mounted}
	<Dialog bind:open={sheetOpen} title="Filters" sheet size="lg">
		{#if sheetOpen}
			<IssueFilters filters={data.filters} sort={data.sort} options={data.options} sticky />
		{/if}
	</Dialog>
{/if}

{#if chips.length > 0}
	<ul class="chips" aria-label="Active filters">
		{#each chips as c (c.key)}
			<li>
				<a class="chip" href={c.href}
					>{c.text}<span class="x" aria-hidden="true"><Icon name="close" size={12} /></span><span
						class="sr-only"
					>
						(remove)</span
					></a
				>
			</li>
		{/each}
		<li><a class="clear" href="/issues">Clear all</a></li>
	</ul>
{/if}

<div class="notes">
	<Banner
		tone="warning"
		message={data.ignored > 0 ? 'Some filters were ignored because they were not valid.' : null}
	/>
	<Banner
		tone="warning"
		message={data.stale > 0
			? `${data.stale} ${data.stale === 1 ? 'filter no longer applies' : 'filters no longer apply'} (a project, label or milestone was removed).`
			: null}
	/>
</div>

<ViewPicker
	base="/issues"
	kind="issues"
	query={page.url.searchParams.toString()}
	views={data.options.views.map((v) => ({ ...v, kind: 'issues' }))}
	archived={false}
	answer={answerFor(form, 'views')}
	actionFor={(action) => issuesAction(search, action)}
	saveAction="saveView"
	deleteAction="deleteView"
/>

{#if data.loadError}
	<Banner tone="error">
		The issues could not be loaded. <a href={page.url.pathname + page.url.search}>Retry</a>
	</Banner>
{:else if loading}
	<div class="skeleton" aria-busy="true" aria-label="Loading issues">
		{#each [0, 1, 2, 3, 4] as i (i)}<span class="bar"></span>{/each}
	</div>
{:else if data.rows.length === 0 && data.active === 0 && data.page === 1}
	<EmptyState
		title="No issues yet"
		description="Report a bug or an idea; it becomes a task in its project."
		action={{ href: '/issues/new', label: 'Report an issue' }}
	/>
{:else if data.rows.length === 0}
	<EmptyState title="No issues match these filters">
		<Button href="/issues">Clear filters</Button>
	</EmptyState>
{:else}
	{#if selectable.length > 0}
		<BulkBar
			id="bulk-form"
			action={issuesAction(search, 'bulk')}
			selectedCount={selected.size}
			pageCount={selectable.length}
			onselectall={(checked) => {
				selected.clear();
				if (checked) for (const r of selectable) selected.add(r.id);
			}}
			oncleared={() => selected.clear()}
			users={data.options.users}
			milestones={[]}
			labels={[]}
			teamLabels={data.options.teamLabels}
			noun="issues"
			answer={bulkAnswer}
		/>
	{/if}
	<IssueTable
		rows={data.rows}
		today={data.today}
		selectForm={selectable.length > 0 ? 'bulk-form' : undefined}
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
		<span class="showing">Showing {first}–{last} of {totalLabel}</span>
		<span class="pages">
			{#if data.page > 1}
				<Button href={issuesPage(search, data.page - 1)} size="sm">Previous</Button>
			{/if}
			{#if hasNext}
				<Button href={issuesPage(search, data.page + 1)} size="sm">Next</Button>
			{/if}
		</span>
	</nav>
{/if}

<style>
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 10px 12px;
		margin-bottom: 12px;
	}
	.sheet-open {
		display: inline-flex;
	}
	@media (min-width: 768px) {
		.sheet-open {
			display: none;
		}
	}
	.sort {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 8px;
		min-width: 0;
	}
	.text-search {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		margin-left: auto;
		color: var(--accent);
		font-size: 13px;
	}
	@media (pointer: coarse) {
		.text-search {
			min-height: 44px;
		}
	}
	.inline-filters {
		margin-bottom: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	@media (max-width: 767px) {
		.inline-filters.phone-hidden {
			display: none;
		}
	}
	summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		padding: 0 14px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
	}
	.count {
		color: var(--accent);
	}
	.inline-body {
		padding: 4px 14px 14px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0 0 12px;
		padding: 0;
		list-style: none;
	}
	.chip,
	.clear {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		min-height: 28px;
		padding: 0 10px;
		border-radius: 999px;
		font-size: 13px;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.chip {
		border: 1px solid var(--accent);
		background: var(--accent-soft);
		color: var(--fg);
	}
	.clear {
		color: var(--accent);
	}
	@media (pointer: coarse) {
		.chip,
		.clear {
			min-height: 44px;
		}
	}
	.x {
		display: inline-flex;
		color: var(--muted);
	}
	.notes {
		display: grid;
		gap: 8px;
	}
	.notes:has(:global(*)) {
		margin-bottom: 12px;
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
	.pager {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: 12px;
		color: var(--muted);
		font-size: 13px;
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
</style>
