<!--
	PageTree: one scope's pages as a nested outline. A page with children is a <details> (open for `openIds`), so
	branches fold and unfold without JavaScript; every title is a link. `currentId` is marked aria-current. A page
	whose children were not loaded (a very large scope) gets a "Show more" link to itself.
-->
<script lang="ts">
	import type { TreeNode } from '#lib/server/kb/tree';
	import PageTree from './PageTree.svelte';

	let {
		nodes,
		currentId = null,
		openIds = [],
		label
	}: {
		nodes: TreeNode[];
		currentId?: string | null;
		openIds?: string[];
		/** Accessible name of the outermost list. */
		label?: string;
	} = $props();
</script>

<ul class="tree" class:nested={(nodes[0]?.depth ?? 1) > 1} aria-label={label}>
	{#each nodes as node (node.id)}
		<li>
			{#if node.children.length > 0}
				<details open={openIds.includes(node.id)}>
					<summary>
						<span class="chevron" aria-hidden="true"></span>
						<a
							href="/kb/{node.id}"
							class="node"
							aria-current={node.id === currentId ? 'page' : undefined}>{node.title}</a
						>
						<span class="sr-only">({node.children.length} subpages)</span>
					</summary>
					<PageTree nodes={node.children} {currentId} {openIds} />
				</details>
			{:else}
				<div class="leaf">
					<span class="spacer" aria-hidden="true"></span>
					<a
						href="/kb/{node.id}"
						class="node"
						aria-current={node.id === currentId ? 'page' : undefined}>{node.title}</a
					>
				</div>
				{#if node.more}
					<a class="more" href="/kb/{node.id}">Show more under “{node.title}”</a>
				{/if}
			{/if}
		</li>
	{/each}
</ul>

<style>
	.tree {
		margin: 0;
		padding: 0;
		list-style: none;
		min-width: 0;
	}
	.nested {
		padding-left: 14px;
		margin-left: 8px;
		border-left: 1px solid var(--border);
	}
	summary,
	.leaf {
		display: flex;
		align-items: center;
		gap: 2px;
		min-width: 0;
		min-height: 32px;
		border-radius: var(--radius-s);
	}
	summary {
		list-style: none;
		cursor: pointer;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary:hover,
	.leaf:hover {
		background: var(--surface-2);
	}
	.chevron,
	.spacer {
		flex: none;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
	}
	.chevron::before {
		content: '';
		width: 6px;
		height: 6px;
		border-right: 1.5px solid var(--muted);
		border-bottom: 1.5px solid var(--muted);
		transform: rotate(-45deg);
		transition: transform 0.12s ease;
	}
	details[open] > summary .chevron::before {
		transform: rotate(45deg);
	}
	@media (prefers-reduced-motion: reduce) {
		.chevron::before {
			transition: none;
		}
	}
	.node {
		flex: 1;
		min-width: 0;
		padding: 4px 6px;
		color: var(--fg);
		font-size: 14px;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.node:hover {
		text-decoration: underline;
	}
	.node[aria-current='page'] {
		color: var(--accent);
		font-weight: 600;
	}
	.more {
		display: inline-block;
		margin: 0 0 4px 24px;
		color: var(--accent);
		font-size: 13px;
	}
	/* Touch: every row is a 44 px target. */
	@media (pointer: coarse) {
		summary,
		.leaf {
			min-height: 44px;
		}
		.chevron,
		.spacer {
			width: 32px;
			height: 44px;
		}
		.more {
			display: flex;
			align-items: center;
			min-height: 44px;
		}
	}
</style>
