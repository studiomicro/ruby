<script lang="ts">
	import { enhance } from '$app/forms';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';

	let { data, form } = $props();
	let purging = $state(false);

	const result = $derived(form && 'purged' in form ? form.purged : null);
	const notice = $derived.by(() => {
		if (!result) return null;
		const files = `${result.purged} file${result.purged === 1 ? '' : 's'} purged.`;
		return result.more ? `${files} More are left: purge again.` : files;
	});
</script>

<svelte:head><title>Attachment retention · Ruby</title></svelte:head>

<PageHeader
	title="Attachment retention"
	description="Files of tasks, pages and projects deleted {data.days} or more days ago."
/>

<section class="retention">
	<Banner tone="success" message={notice} />
	{#if result && result.failedDeletes > 0}
		<Banner
			tone="warning"
			message="Some stored files could not be removed; the runbook's orphan sweep removes them."
		/>
	{/if}
	<Banner tone="error" message={form && 'purgeError' in form ? form.purgeError : null} />

	<p>
		Files on a deleted task or page cannot be downloaded, and come back if the item is restored.
		After
		{data.days} days they are purged: removed for good, with no way back.
	</p>

	{#if data.purgeable === 0}
		<p class="muted">Nothing to purge.</p>
	{:else}
		<p><strong>{data.purgeable >= 1000 ? '1000+' : data.purgeable}</strong> files can be purged.</p>
		<form
			method="POST"
			action="?/purge"
			use:enhance={() => {
				purging = true;
				return async ({ update }) => {
					await update();
					purging = false;
				};
			}}
		>
			<label class="confirm">
				<input type="checkbox" name="confirm" value="yes" required />
				I understand these files are removed for good.
			</label>
			<Button type="submit" variant="danger" loading={purging} loadingLabel="Purging…">
				Purge files
			</Button>
		</form>
	{/if}
</section>

<style>
	.retention {
		display: grid;
		gap: 12px;
		max-width: 60ch;
	}
	p {
		margin: 0;
	}
	.muted {
		color: var(--muted);
	}
	form {
		display: grid;
		justify-items: start;
		gap: 10px;
	}
	.confirm {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
	}
	.confirm input {
		width: 20px;
		height: 20px;
	}
</style>
