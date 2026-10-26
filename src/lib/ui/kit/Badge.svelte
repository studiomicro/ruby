<!--
	Badge: a small label (a role, a status, a count). `tone` neutral, accent, success, warning or danger. Text
	only; give it words, not just a colour.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		tone = 'neutral',
		children
	}: {
		tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
		children: Snippet;
	} = $props();
</script>

<span class="badge {tone}">{@render children()}</span>

<style>
	/* Kumo Badge: a 12 px pill on a tint, the text in the tone's colour. */
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 20px;
		padding: 0 8px;
		box-sizing: border-box;
		border-radius: 999px;
		font-size: var(--text-xs);
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
	}
	.neutral {
		background: var(--surface-3);
		color: var(--fg);
	}
	.accent {
		background: var(--accent-soft);
		color: var(--accent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
	}
	.success {
		background: var(--success-soft);
		color: var(--success);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--success) 18%, transparent);
	}
	.warning {
		background: var(--warning-soft);
		color: var(--warning);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warning) 18%, transparent);
	}
	.danger {
		background: var(--danger-soft);
		color: var(--danger);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 18%, transparent);
	}
</style>
