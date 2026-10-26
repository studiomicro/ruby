<!--
	Card: a bordered surface for one block of a page (Kumo's LayerCard). An optional header holds a `title` (an <h2>
	unless `level` says 3 or 4, so headings never skip), a `description` and `actions` (buttons on the right; they wrap
	under the title on a phone). With a title the card is a <section> labelled by it. `flush` drops the body padding
	for a list or table that runs edge to edge.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	const uid = $props.id();
	let {
		title,
		description,
		level = 2,
		flush = false,
		actions,
		children
	}: {
		title?: string;
		description?: string;
		level?: 2 | 3 | 4;
		flush?: boolean;
		actions?: Snippet;
		children: Snippet;
	} = $props();

	const headingId = $derived(`${uid}-title`);
</script>

<svelte:element
	this={title ? 'section' : 'div'}
	class="card"
	aria-labelledby={title ? headingId : undefined}
>
	{#if title || actions}
		<header class="head">
			{#if title}
				<div class="text">
					<svelte:element this={`h${level}`} id={headingId} class="title">{title}</svelte:element>
					{#if description}<p class="description">{description}</p>{/if}
				</div>
			{/if}
			{#if actions}<div class="actions">{@render actions()}</div>{/if}
		</header>
	{/if}
	<div class="body" class:flush>{@render children()}</div>
</svelte:element>

<style>
	.card {
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
		box-shadow: var(--shadow-1);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 12px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
	}
	.text {
		flex: 1 1 200px;
		min-width: 0;
	}
	.title {
		margin: 0;
		color: var(--fg-strong);
		font-size: var(--text-base);
		font-weight: 600;
	}
	.description {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.body {
		padding: 16px;
	}
	.body.flush {
		padding: 0;
	}
	@media (max-width: 420px) {
		.head {
			padding: 12px;
		}
		.body {
			padding: 12px;
		}
	}
</style>
