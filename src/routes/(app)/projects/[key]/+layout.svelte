<script lang="ts">
	import { page } from '$app/state';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';

	let { data, children } = $props();
	const base = $derived(`/projects/${data.project.key}`);
	/** Task pages carry their own <h1> (the task title); the project name is then a link above it. */
	const onTask = $derived(/\/tasks\/\[number\]$/.test(page.route.id ?? ''));
	const tab = $derived.by(() => {
		const id = page.route.id ?? '';
		if (id.endsWith('/settings')) return 'settings';
		if (id.endsWith('/[key]'))
			return page.url.searchParams.get('view') === 'board' ? 'board' : 'list';
		return null;
	});
	const tabs = $derived([
		{ id: 'list', label: 'List', href: base },
		{ id: 'board', label: 'Board', href: `${base}?view=board` },
		{ id: 'settings', label: 'Settings', href: `${base}/settings` }
	]);
</script>

<header class="project-header">
	<div class="title-row">
		<Badge tone="accent">{data.project.key}</Badge>
		{#if onTask}
			<a class="crumb" href={base}>{data.project.name}</a>
		{:else}
			<h1>{data.project.name}</h1>
		{/if}
		{#if data.project.status === 'archived'}<Badge tone="warning">Archived</Badge>{/if}
	</div>
	{#if !onTask}
		<p class="lead">
			Lead: {data.project.leadName ?? 'nobody'}
		</p>
	{/if}
	<nav class="tabs" aria-label="Project">
		{#each tabs as t (t.id)}
			<a href={t.href} class="tab" aria-current={tab === t.id ? 'page' : undefined}>{t.label}</a>
		{/each}
		<a href="/kb/projects/{data.project.key}" class="tab" data-sveltekit-reload>Docs</a>
	</nav>
</header>

{#if data.project.status === 'archived'}
	<div class="archived">
		<Banner tone="warning"
			>This project is archived: its tasks are read-only.{#if data.canManage}
				Unarchive it in <a href="{base}/settings">Settings</a>.{/if}</Banner
		>
	</div>
{/if}

<svelte:head>
	{#if !onTask}<title>{data.project.name} · Ruby</title>{/if}
</svelte:head>

{@render children()}

<style>
	.project-header {
		display: grid;
		gap: 6px;
		margin-bottom: 16px;
	}
	.title-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 10px;
		min-width: 0;
	}
	h1 {
		margin: 0;
		font-size: 22px;
		line-height: 1.25;
		font-weight: 600;
		letter-spacing: -0.015em;
		min-width: 0;
	}
	.crumb {
		display: inline-flex;
		align-items: center;
		color: var(--muted);
		font-size: 14px;
		font-weight: 500;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	@media (pointer: coarse) {
		.crumb {
			min-height: 44px;
		}
	}
	.crumb:hover {
		color: var(--fg);
		text-decoration: underline;
	}
	.lead {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
	.tabs {
		display: flex;
		gap: 2px;
		margin-top: 6px;
		border-bottom: 1px solid var(--border);
		overflow-x: auto;
		scrollbar-width: none;
	}
	.tab {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		padding: 0 12px;
		margin-bottom: -1px;
		border-bottom: 2px solid transparent;
		color: var(--muted);
		font-size: 14px;
		font-weight: 500;
		text-decoration: none;
		white-space: nowrap;
	}
	@media (pointer: coarse) {
		.tab {
			min-height: 44px;
		}
	}
	.tab:hover {
		color: var(--fg);
	}
	.tab[aria-current='page'] {
		color: var(--fg);
		border-bottom-color: var(--accent);
	}
	.archived {
		margin-bottom: 16px;
	}
	.archived a {
		color: inherit;
		font-weight: 600;
	}
</style>
