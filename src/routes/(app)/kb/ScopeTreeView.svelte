<!--
	ScopeTreeView: a scope's outline on its own page (the knowledge base index, a project's space), with the note
	shown when a very large scope was cut to its top levels.
-->
<script lang="ts">
	import type { ScopeTree } from '#lib/server/kb/load';
	import PageTree from './PageTree.svelte';

	let { tree, label }: { tree: ScopeTree; label: string } = $props();
</script>

<section class="outline" aria-label={label}>
	<PageTree nodes={tree.nodes} openIds={tree.openIds} {label} />
	{#if tree.truncated}
		<p class="note">
			This space has more pages than one outline shows. Deeper pages are listed on their parent
			page.
		</p>
	{/if}
</section>

<style>
	.outline {
		padding: 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.note {
		margin: 10px 6px 4px;
		color: var(--muted);
		font-size: 13px;
	}
</style>
