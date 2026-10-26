<script lang="ts">
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';

	import type { PageData } from './$types';

	type Node = PageData['tree'][number];
	let { data } = $props();
</script>

<PageHeader title="Org chart" description="Who reports to whom. Open a person to see their team.">
	{#snippet actions()}
		<Button href="/people" variant="ghost">Directory</Button>
	{/snippet}
</PageHeader>

{#if data.capped}
	<Banner
		tone="warning"
		message="The org chart shows the first {data.count} people only. Use the directory to find everyone."
	/>
{/if}

{#snippet branch(node: Node, depth: number)}
	{#if node.children.length > 0}
		<details open={depth < 2}>
			<summary>
				<span class="who">
					<a href="/people/{node.id}">{node.name}</a>
					{#if node.title}<span class="title">{node.title}</span>{/if}
				</span>
				<span class="reports"
					>{node.reportCount} {node.reportCount === 1 ? 'report' : 'reports'}</span
				>
			</summary>
			<ul>
				{#each node.children as child (child.id)}
					<li>{@render branch(child, depth + 1)}</li>
				{/each}
			</ul>
		</details>
	{:else}
		<div class="leaf">
			<span class="who">
				<a href="/people/{node.id}">{node.name}</a>
				{#if node.title}<span class="title">{node.title}</span>{/if}
			</span>
			{#if node.truncated}<span class="reports">{node.reportCount} more below …</span>{/if}
		</div>
	{/if}
{/snippet}

{#if data.tree.length === 0}
	<EmptyState title="No employees yet" description="The org chart fills in as HR adds people." />
{:else}
	<div class="chart" role="region" aria-label="Org chart" tabindex="-1">
		<ul class="roots">
			{#each data.tree as root (root.id)}
				<li>{@render branch(root, 0)}</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	/* The chart scrolls inside its own box, never the page (deep trees get wide on phones). */
	.chart {
		max-height: min(70dvh, 900px);
		overflow: auto;
		overscroll-behavior: contain;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	ul ul {
		margin-left: 14px;
		padding-left: 12px;
		border-left: 1px solid var(--border);
	}
	.roots,
	ul ul {
		width: max-content;
		min-width: 100%;
	}
	summary,
	.leaf {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 2px 8px;
		border-radius: var(--radius-m);
		white-space: nowrap;
	}
	summary {
		cursor: pointer;
	}
	summary:hover {
		background: var(--surface-2);
	}
	.who {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.who a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--fg);
		font-weight: 500;
		text-decoration: none;
	}
	.who a:hover {
		text-decoration: underline;
	}
	.title,
	.reports {
		color: var(--muted);
		font-size: 13px;
	}
	.reports {
		margin-left: auto;
		padding-left: 8px;
	}
</style>
