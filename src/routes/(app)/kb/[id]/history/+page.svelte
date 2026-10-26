<script lang="ts">
	import { enhance } from '$app/forms';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Breadcrumbs from '../../Breadcrumbs.svelte';

	let { data, form } = $props();
	let restoring = $state<number | null>(null);
</script>

<Breadcrumbs project={data.page.project} ancestors={data.breadcrumbs} current={data.page} />
<PageHeader
	title="History of “{data.page.title}”"
	description="Every saved version. Restoring one saves it again as a new revision."
/>

<Banner tone="error" message={form?.restoreError} />

<ol class="revisions">
	{#each data.revisions as rev (rev.revision)}
		{@const current = rev.revision === data.page.revision}
		<li class="row">
			<div class="main-cell">
				<span class="primary-text">
					<span class="num">Revision {rev.revision}</span>
					{#if current}<Badge tone="accent">Current</Badge>{/if}
				</span>
				<span class="title">{rev.title}</span>
				<span class="secondary-text"
					>{rev.editedByName} · <LocalTime at={rev.createdAt} withTime /></span
				>
			</div>
			<div class="row-actions">
				<Button href="/kb/{data.page.id}/history/{rev.revision}" size="sm">View</Button>
				{#if !current}
					<form
						method="POST"
						action="?/restore"
						use:enhance={() => {
							restoring = rev.revision;
							return async ({ update }) => {
								await update();
								restoring = null;
							};
						}}
					>
						<input type="hidden" name="revision" value={rev.revision} />
						<input type="hidden" name="expectedRevision" value={data.page.revision} />
						<Button
							type="submit"
							size="sm"
							loading={restoring === rev.revision}
							loadingLabel="Restoring…">Restore</Button
						>
					</form>
				{/if}
			</div>
		</li>
	{/each}
</ol>

{#if data.pages > 1}
	<nav class="pager" aria-label="History pages">
		{#if data.pageNo > 1}
			<Button href="?page={data.pageNo - 1}" size="sm">Newer</Button>
		{/if}
		<span>Page {data.pageNo} of {data.pages}</span>
		{#if data.pageNo < data.pages}
			<Button href="?page={data.pageNo + 1}" size="sm">Older</Button>
		{/if}
	</nav>
{/if}

<style>
	.revisions {
		margin: 16px 0 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 16px;
		padding: 10px 14px;
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.main-cell {
		display: grid;
		gap: 2px;
		min-width: 0;
		flex: 1 1 220px;
	}
	.primary-text {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-weight: 600;
		font-size: 14px;
	}
	.title {
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.secondary-text {
		color: var(--muted);
		font-size: 13px;
	}
	.row-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.pager {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-top: 14px;
		color: var(--muted);
		font-size: 14px;
	}
</style>
