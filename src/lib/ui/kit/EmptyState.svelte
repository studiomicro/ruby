<!--
	EmptyState: what a list or page shows when there is nothing yet (or nothing found). `title`, optional
	`description`, and either `action` ({ href, label }) for one link or `children` for custom buttons.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';

	let {
		title,
		description,
		action,
		children
	}: {
		title: string;
		description?: string;
		action?: { href: string; label: string };
		children?: Snippet;
	} = $props();
</script>

<div class="empty">
	<p class="title">{title}</p>
	{#if description}<p class="description">{description}</p>{/if}
	{#if children}
		<div class="actions">{@render children()}</div>
	{:else if action}
		<div class="actions"><Button href={action.href} variant="primary">{action.label}</Button></div>
	{/if}
</div>

<style>
	/* Kumo Empty: a bordered, 12 px rounded panel with a centred heading, text and action. */
	.empty {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: 40px 24px;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--surface);
		text-align: center;
	}
	@media (max-width: 420px) {
		.empty {
			padding: 32px 16px;
		}
	}
	.title {
		margin: 0;
		color: var(--fg-strong);
		font-size: var(--text-lg);
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.description {
		margin: 0;
		max-width: 46ch;
		color: var(--muted);
		font-size: var(--text-base);
		text-wrap: balance;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px;
		margin-top: 12px;
	}
</style>
