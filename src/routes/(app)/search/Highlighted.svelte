<!--
	Highlighted: search text segments (#lib/server/search/query splitMarkedSnippet) as text nodes, the hits inside
	<mark>. Never {@html}: a page's `<script>` or `<img onerror>` stays visible text.
-->
<script lang="ts">
	import type { Segment } from '#lib/server/search/query';

	let { segments }: { segments: Segment[] } = $props();
</script>

{#each segments as segment, i (i)}{#if segment.hit}<mark>{segment.text}</mark
		>{:else}{segment.text}{/if}{/each}

<style>
	mark {
		padding: 0 1px;
		border-radius: 3px;
		background: var(--warning-soft);
		color: inherit;
		font-weight: 600;
	}
</style>
