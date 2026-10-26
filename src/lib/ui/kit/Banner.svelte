<!--
	Banner: a form-level or page-level message. `tone` error (role=alert, read out at once), success or info
	(role=status). Renders nothing without `message` or children, so `<Banner tone="error" message={form?.error} />`
	is safe to leave in place.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		tone = 'info',
		message,
		children
	}: {
		tone?: 'error' | 'success' | 'info' | 'warning';
		message?: string | null;
		children?: Snippet;
	} = $props();
</script>

{#if message || children}
	<div class="banner {tone}" role={tone === 'error' ? 'alert' : 'status'}>
		{#if children}{@render children()}{:else}{message}{/if}
	</div>
{/if}

<style>
	/* Kumo Banner: the tone's tint, its text colour, 8 px radius; a faint edge of the same colour. */
	.banner {
		padding: 10px 14px;
		border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		border-radius: var(--radius-l);
		font-size: var(--text-base);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}
	.error {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.success {
		background: var(--success-soft);
		color: var(--success);
	}
	.warning {
		background: var(--warning-soft);
		color: var(--warning);
	}
	.info {
		background: var(--accent-soft);
		color: var(--accent);
	}
</style>
