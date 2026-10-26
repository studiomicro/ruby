<script lang="ts">
	import { page } from '$app/state';
	import Button from '#lib/ui/kit/Button.svelte';

	const heading = $derived(
		page.status === 404
			? 'Page not found'
			: page.status === 403
				? 'Not allowed'
				: page.status === 401
					? 'Signed out'
					: 'Something went wrong'
	);
</script>

<svelte:head><title>{heading} · Ruby</title></svelte:head>

<main class="error-page">
	<p class="status">{page.status}</p>
	<h1>{heading}</h1>
	<p class="message">{page.error?.message ?? ''}</p>
	{#if page.error?.id}<p class="ref">Reference: {page.error.id}</p>{/if}
	<div class="actions">
		{#if page.status === 401}
			<Button href="/login" variant="primary">Sign in</Button>
		{:else}
			<Button href="/" variant="primary">Go to Home</Button>
		{/if}
	</div>
</main>

<style>
	.error-page {
		display: grid;
		justify-items: start;
		gap: 6px;
		max-width: 480px;
		margin: 0 auto;
		padding: calc(64px + var(--sai-top)) max(16px, var(--sai-right)) 48px max(16px, var(--sai-left));
	}
	.status {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
		font-variant-numeric: tabular-nums;
	}
	h1 {
		margin: 0;
		font-size: 22px;
		font-weight: 600;
	}
	.message,
	.ref {
		margin: 0;
		color: var(--muted);
	}
	.ref {
		font-size: 13px;
	}
	.actions {
		margin-top: 14px;
	}
</style>
