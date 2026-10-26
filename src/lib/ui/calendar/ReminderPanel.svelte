<!--
	ReminderPanel: the viewer's own reminders on a task or an event (RB-09), with the add form (presets; a task also
	takes a set date and time) and a remove button per pending reminder. Posts to the host page's `?/reminderAdd` and
	`?/reminderRemove`; works without JavaScript. Success is shown only after the server confirmed it.
-->
<script lang="ts">
	import { enhance } from '#lib/ui/pwa/offline-form';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Card from '#lib/ui/kit/Card.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import { OUTCOME_TEXT, whenText } from './when';

	interface Panel {
		kind: 'task' | 'event';
		reminders: {
			id: string;
			label: string;
			at: number;
			pending: boolean;
			outcome: 'sent' | 'missed' | 'canceled' | 'dead' | null;
		}[];
		presets: { offset: number; label: string }[];
		noDueDate: boolean;
		atLimit: boolean;
	}

	let {
		panel,
		result,
		zone,
		zoneLabel,
		today
	}: {
		panel: Panel;
		/** The host page's `form?.reminder`. */
		result?: { error?: string; added?: boolean; removed?: boolean } | null;
		zone: string;
		zoneLabel: string;
		today: string;
	} = $props();

	let saving = $state<'preset' | 'absolute' | null>(null);
	let removing = $state<string | null>(null);
	const presetOptions = $derived(
		panel.presets.map((p) => ({ value: String(p.offset), label: p.label }))
	);
	const pending = $derived(panel.reminders.filter((r) => r.pending));
	const closed = $derived(panel.reminders.filter((r) => !r.pending));
</script>

<div class="reminders" id="reminders">
	<Card title="Reminders" description="Only you see your reminders. They arrive in Notifications.">
		<div class="stack">
			<Banner tone="error" message={result?.error ?? null} />
			<Banner
				tone="success"
				message={result?.added ? 'Reminder set.' : result?.removed ? 'Reminder removed.' : null}
			/>

			{#if pending.length === 0}
				<p class="empty">No reminders.</p>
			{:else}
				<ul class="list">
					{#each pending as r (r.id)}
						<li>
							<span class="text">
								<span class="label">{r.label}</span>
								<span class="when">{whenText(r.at, zone, zoneLabel, today)}</span>
							</span>
							<form
								method="POST"
								action="?/reminderRemove"
								use:enhance={() => {
									removing = r.id;
									return async ({ update }) => {
										await update({ reset: false });
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
									loadingLabel="Removing…"
									label="Remove reminder {r.label}">Remove</Button
								>
							</form>
						</li>
					{/each}
				</ul>
			{/if}

			{#if panel.atLimit}
				<p class="note">You can have up to 10 reminders here.</p>
			{:else}
				{#snippet addForm(absolute: boolean)}
					<form
						method="POST"
						action="?/reminderAdd"
						class="add"
						use:enhance={() => {
							saving = absolute ? 'absolute' : 'preset';
							return async ({ update }) => {
								await update({ reset: false });
								saving = null;
							};
						}}
					>
						{#if absolute}
							<input type="hidden" name="mode" value="absolute" />
							<div class="pair">
								<TextField label="Date" name="date" type="date" required value={today} />
								<TextField
									label="Time ({zoneLabel})"
									name="time"
									type="time"
									step={300}
									required
									value="09:00"
								/>
							</div>
						{:else}
							<Select label="Remind me" name="offset" options={presetOptions} />
						{/if}
						<Button
							type="submit"
							loading={saving === (absolute ? 'absolute' : 'preset')}
							loadingLabel="Saving…">Add reminder</Button
						>
					</form>
				{/snippet}
				{#if panel.kind === 'task' && panel.noDueDate}
					<p class="note">Set a due date first to be reminded before it.</p>
				{:else}
					{@render addForm(false)}
				{/if}
				{#if panel.kind === 'task'}
					<details class="history" open={panel.noDueDate}>
						<summary>At a set time</summary>
						{@render addForm(true)}
					</details>
				{/if}
			{/if}

			{#if closed.length > 0}
				<details class="history">
					<summary>Earlier reminders</summary>
					<ul class="list">
						{#each closed as r (r.id)}
							<li>
								<span class="text">
									<span class="label">{r.label}</span>
									<span class="when"
										>{whenText(r.at, zone, zoneLabel, today)} · {r.outcome
											? OUTCOME_TEXT[r.outcome]
											: ''}</span
									>
								</span>
							</li>
						{/each}
					</ul>
				</details>
			{/if}
		</div>
	</Card>
</div>

<style>
	.reminders {
		min-width: 0;
	}
	.stack {
		display: grid;
		gap: 12px;
	}
	.note,
	.empty {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.list {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}
	.text {
		display: grid;
		min-width: 0;
		font-size: var(--text-sm);
	}
	.label {
		font-weight: 500;
	}
	.when {
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.add {
		display: grid;
		gap: 10px;
	}
	.pair {
		display: grid;
		gap: 10px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 130px), 1fr));
	}
	.history summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		cursor: pointer;
		font-size: var(--text-sm);
		color: var(--muted);
	}
</style>
