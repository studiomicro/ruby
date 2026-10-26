<script lang="ts">
	import { enhance } from '$app/forms';
	import { offsetLabel } from '#lib/shared/calendar';
	import { OUTCOME_TEXT, whenText } from '#lib/ui/calendar/when';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Card from '#lib/ui/kit/Card.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data, form } = $props();

	const zone = $derived(data.clock.zone);
	const label = $derived(data.clock.zoneLabel);
	const today = $derived(data.clock.today);
	const values = $derived(form && 'values' in form ? form.values : null);
	let saving = $state(false);
	let removing = $state<string | null>(null);

	type Row = (typeof data.pending)[number];
	const what = (r: Row) =>
		r.targetKind === 'personal'
			? r.title
			: r.mode === 'relative'
				? offsetLabel(r.targetKind, r.offsetMin ?? 0)
				: 'At a set time';
</script>

<PageHeader title="My reminders" description="Only you see these. Times are in {label}.">
	{#snippet actions()}
		<Button href="/calendar" variant="ghost">Calendar</Button>
		<Button href="/notifications" variant="ghost">Notifications</Button>
	{/snippet}
</PageHeader>

<div class="banners">
	{#if data.schedulerLate === null}
		<Banner tone="warning" message="Reminders may be delayed: the scheduler has not run yet." />
	{:else if data.schedulerLate > 0}
		<Banner
			tone="warning"
			message="Reminders may be delayed: the scheduler has not run for {data.schedulerLate} minutes."
		/>
	{/if}
	<Banner tone="error" message={form && 'error' in form ? form.error : null} />
	<Banner
		tone="success"
		message={form && 'created' in form
			? 'Reminder set.'
			: form && 'removed' in form
				? 'Reminder removed.'
				: null}
	/>
</div>

<div class="new-card">
	<Card title="New personal reminder">
		<form
			method="POST"
			action="?/create"
			class="new"
			use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update();
					saving = false;
				};
			}}
		>
			<TextField
				label="Remind me to"
				name="title"
				required
				maxlength={120}
				value={values?.title ?? ''}
			/>
			<div class="pair">
				<TextField label="Date" name="date" type="date" required value={values?.date ?? today} />
				<TextField
					label="Time ({label})"
					name="time"
					type="time"
					step={300}
					required
					value={values?.time ?? '09:00'}
				/>
			</div>
			<div>
				<Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…"
					>Add reminder</Button
				>
			</div>
		</form>
	</Card>
</div>

<div class="list-section">
	<Card title="Pending" flush>
		{#if data.pending.length === 0}
			<div class="empty">
				<EmptyState
					title="No reminders"
					description="Add one here, or from a task or an event page."
				/>
			</div>
		{:else}
			<ul class="rows">
				{#each data.pending as r (r.id)}
					<li class="row">
						<div class="text">
							<p class="what">
								{#if r.targetKind !== 'personal'}
									{#if r.href}<a href={r.href}>{r.targetTitle}</a>{:else}<span class="gone"
											>No longer available</span
										>{/if}
									·
								{/if}
								{what(r)}
							</p>
							<p class="when">{whenText(r.fireAt, zone, label, today)}</p>
						</div>
						<form
							method="POST"
							action="?/remove"
							use:enhance={() => {
								removing = r.id;
								return async ({ update }) => {
									await update();
									removing = null;
								};
							}}
						>
							<input type="hidden" name="id" value={r.id} />
							<Button
								type="submit"
								size="sm"
								variant="ghost"
								loading={removing === r.id}
								loadingLabel="Removing…">Remove</Button
							>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>
</div>

{#if data.history.length > 0}
	<div class="list-section">
		<Card title="History" flush>
			<ul class="rows">
				{#each data.history as r (r.id)}
					<li class="row">
						<div class="text">
							<p class="what">
								{#if r.targetKind !== 'personal'}
									{#if r.href}<a href={r.href}>{r.targetTitle}</a>{:else}<span class="gone"
											>No longer available</span
										>{/if}
									·
								{/if}
								{what(r)}
							</p>
							<p class="when">
								{whenText(r.fireAt, zone, label, today)} · {r.outcome
									? OUTCOME_TEXT[r.outcome]
									: ''}
							</p>
						</div>
					</li>
				{/each}
			</ul>
		</Card>
	</div>
{/if}

<style>
	.banners {
		display: grid;
		gap: 8px;
		margin-bottom: 12px;
	}
	.new-card {
		max-width: 640px;
		margin-bottom: 20px;
	}
	.empty {
		padding: 12px;
	}
	.new {
		display: grid;
		gap: 10px;
	}
	.pair {
		display: grid;
		gap: 10px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
	}
	.list-section {
		display: grid;
		gap: 8px;
		margin-bottom: 20px;
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 12px;
		border-top: 1px solid var(--border);
		min-width: 0;
	}
	.row:first-child {
		border-top: 0;
	}
	.text {
		min-width: 0;
	}
	.what,
	.when {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.what {
		font-size: var(--text-base);
	}
	.what a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
	}
	.when {
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.gone {
		color: var(--muted);
		font-style: italic;
	}
</style>
