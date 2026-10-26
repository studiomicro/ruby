<script lang="ts">
	import { navigating } from '$app/state';
	import { TASK_STATUS_LABELS } from '#lib/shared/enums';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import Icon from '#lib/ui/kit/Icon.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import Highlighted from './Highlighted.svelte';
	import TypeBadge from '#lib/ui/issues/TypeBadge.svelte';

	let { data } = $props();

	const TYPE_OPTIONS = [
		{ value: 'all', label: 'Pages and tasks' },
		{ value: 'pages', label: 'Pages' },
		{ value: 'tasks', label: 'Tasks' }
	];
	const searching = $derived(navigating.to?.url.pathname === '/search');
	const results = $derived(data.state === 'results' ? data.results : null);
	const nothing = $derived(
		results !== null &&
			results.pages.length === 0 &&
			results.tasks.length === 0 &&
			results.exact === null
	);
	const showPages = $derived(data.type !== 'tasks');
	const showTasks = $derived(data.type !== 'pages');
</script>

<PageHeader title="Search" description="Find pages and tasks by the words in them." />

<form method="GET" class="search-form" role="search">
	<div class="query">
		<TextField
			label="Search"
			hideLabel
			name="q"
			type="search"
			value={data.q}
			placeholder="Search pages and tasks"
			maxlength={200}
			autocomplete="off"
		/>
	</div>
	<Select label="Look in" hideLabel name="type" options={TYPE_OPTIONS} value={data.type} />
	<Button type="submit" variant="primary" loading={searching} loadingLabel="Searching…"
		>Search</Button
	>
</form>

{#if searching}
	<p class="status" role="status">Searching…</p>
{:else if data.state === 'initial'}
	<p class="status">Type to search pages and tasks.</p>
{:else if data.state === 'too-short'}
	<p class="status">Use at least one letter or number.</p>
{:else if data.state === 'unavailable'}
	<Banner tone="error" message="Search is unavailable, try again." />
{:else if results && nothing}
	<EmptyState title="No results for “{data.q}”" description="Try fewer or shorter words." />
{:else if results}
	{#if results.exact}
		{@const task = results.exact}
		<section aria-labelledby="exact-heading" class="group">
			<h2 id="exact-heading">Exact match</h2>
			<ul class="hits">
				<li class="hit">
					<span class="kind"><Icon name="tasks" /></span>
					<div class="hit-main">
						<a class="hit-title" href="/projects/{task.key}/tasks/{task.number}"
							><span class="ref">{task.key}-{task.number}</span>
							<Highlighted segments={task.title} /></a
						>
						<span class="context">
							<TypeBadge type={task.type} />
							<Badge>{TASK_STATUS_LABELS[task.status]}</Badge>
							{#if task.archived}<Badge tone="warning">Archived</Badge>{/if}
							<LocalTime at={task.updatedAt} />
						</span>
					</div>
				</li>
			</ul>
		</section>
	{/if}

	{#if showPages}
		<section aria-labelledby="pages-heading" class="group">
			<h2 id="pages-heading">Pages</h2>
			{#if results.pages.length === 0}
				<p class="status">No pages match.</p>
			{:else}
				<ul class="hits">
					{#each results.pages as hit (hit.id)}
						<li class="hit">
							<span class="kind"><Icon name="book" /></span>
							<div class="hit-main">
								<a class="hit-title" href="/kb/{hit.id}"><Highlighted segments={hit.title} /></a>
								<span class="context">
									<Badge>{hit.projectKey ?? 'Team'}</Badge>
									{#if hit.archived}<Badge tone="warning">Archived</Badge>{/if}
									<LocalTime at={hit.updatedAt} />
								</span>
								{#if hit.snippet.length}<p class="snippet">
										<Highlighted segments={hit.snippet} />
									</p>{/if}
							</div>
						</li>
					{/each}
				</ul>
				{#if results.pages.length >= results.limit}
					<p class="note">Showing top {results.limit}.</p>
				{/if}
			{/if}
		</section>
	{/if}

	{#if showTasks}
		<section aria-labelledby="tasks-heading" class="group">
			<h2 id="tasks-heading">Tasks</h2>
			{#if results.tasks.length === 0}
				<p class="status">No {results.exact ? 'other ' : ''}tasks match.</p>
			{:else}
				<ul class="hits">
					{#each results.tasks as hit (hit.id)}
						<li class="hit">
							<span class="kind"><Icon name="tasks" /></span>
							<div class="hit-main">
								<a class="hit-title" href="/projects/{hit.key}/tasks/{hit.number}"
									><span class="ref">{hit.key}-{hit.number}</span>
									<Highlighted segments={hit.title} /></a
								>
								<span class="context">
									<TypeBadge type={hit.type} />
									<Badge>{TASK_STATUS_LABELS[hit.status]}</Badge>
									{#if hit.archived}<Badge tone="warning">Archived</Badge>{/if}
									<LocalTime at={hit.updatedAt} />
								</span>
								{#if hit.snippet.length}<p class="snippet">
										<Highlighted segments={hit.snippet} />
									</p>{/if}
							</div>
						</li>
					{/each}
				</ul>
				{#if results.tasks.length >= results.limit}
					<p class="note">Showing top {results.limit}.</p>
				{/if}
			{/if}
		</section>
	{/if}
{/if}

<style>
	.search-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 8px;
		margin-bottom: 20px;
	}
	.query {
		flex: 1 1 240px;
		min-width: 0;
	}
	.status {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.group + .group {
		margin-top: 22px;
	}
	h2 {
		margin: 0 0 8px;
		font-size: 14px;
		font-weight: 600;
		color: var(--muted);
	}
	.hits {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.hit {
		display: flex;
		gap: 10px;
		padding: 10px 14px;
		min-width: 0;
	}
	.hit + .hit {
		border-top: 1px solid var(--border);
	}
	.kind {
		flex: none;
		padding-top: 2px;
		color: var(--muted);
	}
	.hit-main {
		display: grid;
		gap: 4px;
		min-width: 0;
		flex: 1;
	}
	.hit-title {
		color: var(--fg);
		font-weight: 600;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.hit-title:hover {
		text-decoration: underline;
	}
	@media (pointer: coarse) {
		.hit-title {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0 6px;
			min-height: 44px;
		}
	}
	.ref {
		color: var(--muted);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}
	.context {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		color: var(--muted);
		font-size: 13px;
	}
	.snippet {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.note {
		margin: 6px 0 0;
		color: var(--muted);
		font-size: 13px;
	}
</style>
