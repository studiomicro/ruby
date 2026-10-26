<!--
	Markdown: renders Markdown `source` through #lib/shared/markdown (the one sanitising renderer) and nothing else.
	This is the only {@html} in the app: pass the stored Markdown, never pre-rendered HTML. Styles live in app.css
	(`.markdown`). Works on the server and in the browser (a live preview re-renders as `source` changes). Pass `names`
	(from the server's `mentionNames`) so a mention shows its user's current name, not the label its author typed.
-->
<script lang="ts">
	import { renderMarkdown } from '#lib/shared/markdown';

	let {
		source,
		empty = '',
		names
	}: { source: string; empty?: string; names?: ReadonlyMap<string, string> } = $props();

	const html = $derived(renderMarkdown(source, names));
</script>

{#if html}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- the output of renderMarkdown (html: false, URL allowlist) -->
	<div class="markdown">{@html html}</div>
{:else if empty}
	<p class="empty">{empty}</p>
{/if}

<style>
	.empty {
		margin: 0;
		color: var(--muted);
		font-style: italic;
	}
</style>
