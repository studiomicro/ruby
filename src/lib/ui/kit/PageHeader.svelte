<!--
	PageHeader: the page's one <h1>, an optional `description` and `actions` (buttons on the right; they wrap under
	the title on a phone). Also sets the document title unless `documentTitle` is false.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		documentTitle = true,
		actions
	}: {
		title: string;
		description?: string;
		documentTitle?: boolean;
		actions?: Snippet;
	} = $props();
</script>

<svelte:head>
	{#if documentTitle}<title>{title} · Ruby</title>{/if}
</svelte:head>

<header class="page-header">
	<div class="text">
		<h1>{title}</h1>
		{#if description}<p>{description}</p>{/if}
	</div>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>

<style>
	.page-header {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 12px 16px;
		margin-bottom: 24px;
	}
	.text {
		min-width: 0;
		flex: 1 1 260px;
	}
	/* Kumo's page heading: semibold, tight tracking, the strong text colour. */
	h1 {
		margin: 0;
		color: var(--fg-strong);
		font-size: 22px;
		line-height: 1.25;
		font-weight: 600;
		letter-spacing: -0.02em;
	}
	@media (min-width: 768px) {
		h1 {
			font-size: var(--text-2xl);
		}
	}
	p {
		margin: 4px 0 0;
		max-width: 70ch;
		color: var(--muted);
		font-size: var(--text-base);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
