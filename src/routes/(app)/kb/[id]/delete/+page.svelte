<script lang="ts">
	import { enhance } from '$app/forms';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Breadcrumbs from '../../Breadcrumbs.svelte';

	let { data, form } = $props();
	let deleting = $state(false);
</script>

<Breadcrumbs project={data.page.project} ancestors={data.breadcrumbs} current={data.page} />
<PageHeader title="Delete “{data.page.title}”?" />

<div class="panel">
	{#if !data.canDelete}
		<Banner tone="info" message={data.forbidden} />
		<div class="actions">
			<Button href="/kb/{data.page.id}">Back to the page</Button>
		</div>
	{:else}
		<p>
			{#if data.subpages > 0}
				This deletes the page and its {data.subpages} subpage{data.subpages === 1 ? '' : 's'}. They
				disappear from the outline and from search.
			{:else}
				The page disappears from the outline and from search.
			{/if}
		</p>
		<form
			method="POST"
			action="?/delete"
			use:enhance={() => {
				deleting = true;
				return async ({ update }) => {
					await update();
					deleting = false;
				};
			}}
		>
			<Banner tone="error" message={form?.error} />
			<div class="actions">
				<Button
					type="submit"
					variant="danger"
					name="confirm"
					value="yes"
					loading={deleting}
					loadingLabel="Deleting…">Delete page</Button
				>
				<Button href="/kb/{data.page.id}" variant="ghost">Cancel</Button>
			</div>
		</form>
	{/if}
</div>

<style>
	.panel {
		display: grid;
		gap: 14px;
		max-width: 560px;
		padding: 18px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	p {
		margin: 0;
	}
	form {
		display: grid;
		gap: 12px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
