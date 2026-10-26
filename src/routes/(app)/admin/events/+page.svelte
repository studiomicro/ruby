<script lang="ts">
	import { enhance } from '#lib/ui/pwa/offline-form';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Card from '#lib/ui/kit/Card.svelte';
	import Checkbox from '#lib/ui/kit/Checkbox.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';

	let { data, form } = $props();
	let busy = $state<string | null>(null);
</script>

<PageHeader
	title="Calendar events of deactivated users"
	description="Private events stay private: you see only how many events each deactivated user left behind. Purging removes all of them and is recorded in the audit log."
/>

<div class="banners">
	<Banner
		tone="success"
		message={form && 'purged' in form ? `${form.purged} events purged.` : null}
	/>
	<Banner tone="error" message={form && 'purgeError' in form ? form.purgeError : null} />
</div>

{#if data.candidates.length === 0}
	<EmptyState
		title="Nothing to purge"
		description="No deactivated user has live calendar events."
	/>
{:else}
	<div class="list">
		{#each data.candidates as c (c.userId)}
			<Card
				title={c.name}
				description="{c.events} live {c.events === 1 ? 'event' : 'events'}"
				level={2}
			>
				<form
					method="POST"
					action="?/purge"
					class="purge"
					use:enhance={() => {
						busy = c.userId;
						return async ({ update }) => {
							await update();
							busy = null;
						};
					}}
				>
					<input type="hidden" name="userId" value={c.userId} />
					<Checkbox label="Yes, purge these events" name="confirm" value="yes" required />
					<div>
						<Button
							type="submit"
							variant="danger"
							loading={busy === c.userId}
							loadingLabel="Purging…">Purge events</Button
						>
					</div>
				</form>
			</Card>
		{/each}
	</div>
{/if}

<style>
	.banners {
		display: grid;
		gap: 8px;
		margin-bottom: 12px;
	}
	.list {
		display: grid;
		gap: 12px;
		max-width: 640px;
	}
	.purge {
		display: grid;
		gap: 10px;
	}
</style>
