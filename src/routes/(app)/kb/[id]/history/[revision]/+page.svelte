<script lang="ts">
	import { enhance } from '#lib/ui/pwa/offline-form';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import Markdown from '#lib/ui/kit/Markdown.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Breadcrumbs from '../../../Breadcrumbs.svelte';

	let { data, form } = $props();
	const rev = $derived(data.revision);
	const current = $derived(rev.revision === data.page.revision);
	let restoring = $state(false);
</script>

<Breadcrumbs project={data.page.project} ancestors={data.breadcrumbs} current={data.page} />
<PageHeader title="Revision {rev.revision} of “{data.page.title}”">
	{#snippet actions()}
		<Button href="/kb/{data.page.id}/history">All revisions</Button>
		{#if !current}
			<form
				method="POST"
				action="?/restore"
				use:enhance={() => {
					restoring = true;
					return async ({ update }) => {
						await update();
						restoring = false;
					};
				}}
			>
				<input type="hidden" name="revision" value={rev.revision} />
				<input type="hidden" name="expectedRevision" value={data.page.revision} />
				<Button type="submit" variant="primary" loading={restoring} loadingLabel="Restoring…"
					>Restore this version</Button
				>
			</form>
		{/if}
	{/snippet}
</PageHeader>

<p class="meta">
	{#if current}<Badge tone="accent">Current</Badge>{/if}
	<span>Saved by {rev.editedByName}</span>
	<LocalTime at={rev.createdAt} withTime />
</p>
<Banner tone="error" message={form?.restoreError} />

<article class="revision">
	<h2 class="rev-title">{rev.title}</h2>
	<Markdown source={rev.body} empty="This version was empty." />
</article>

<style>
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		margin: -10px 0 16px;
		color: var(--muted);
		font-size: 13px;
	}
	.revision {
		padding: 16px 18px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
		min-width: 0;
	}
	.rev-title {
		margin: 0 0 12px;
		font-size: 18px;
		font-weight: 600;
	}
</style>
