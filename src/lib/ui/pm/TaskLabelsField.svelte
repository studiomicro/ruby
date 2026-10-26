<!--
	TaskLabelsField: a task's labels in the sidebar (RB-08): the chips, and a checkbox list of the project's labels
	that replaces the set (`?/labelsSet`, at most `max`). Works without JavaScript; with it, saves in place.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import type { LabelColor } from '#lib/shared/enums';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import type { PmAnswer } from './answer';
	import LabelChip from './LabelChip.svelte';

	type Label = { id: string; name: string; color: LabelColor };
	let {
		current,
		labels,
		archived,
		answer,
		settingsHref,
		max
	}: {
		current: readonly Label[];
		labels: readonly Label[];
		archived: boolean;
		answer: PmAnswer | null;
		settingsHref: string;
		max: number;
	} = $props();

	let saving = $state(false);
	const chosen = $derived(new Set(current.map((l) => l.id)));
</script>

<div class="labels">
	<h2 class="title">Labels</h2>
	{#if current.length > 0}
		<div class="chips">
			{#each current as l (l.id)}<LabelChip name={l.name} color={l.color} />{/each}
		</div>
	{:else}
		<p class="none">None</p>
	{/if}
	{#if !archived}
		{#if labels.length === 0}
			<p class="none"><a href={settingsHref}>Add labels in Settings</a></p>
		{:else}
			<details class="edit" open={answer !== null && !answer.ok}>
				<summary>Change labels</summary>
				<form
					method="POST"
					action="?/labelsSet"
					use:enhance={() => {
						saving = true;
						return async ({ update }) => {
							await update({ reset: false });
							saving = false;
						};
					}}
				>
					<fieldset>
						<legend class="sr-only">Labels (up to {max})</legend>
						{#each labels as l (l.id)}
							<label class="check"
								><input
									type="checkbox"
									name="labelId"
									value={l.id}
									checked={chosen.has(l.id)}
								/><LabelChip name={l.name} color={l.color} /></label
							>
						{/each}
					</fieldset>
					<p class="hint">Up to {max} labels.</p>
					<Banner tone="error" message={answer && !answer.ok ? answer.message : null} />
					<div>
						<Button type="submit" size="sm" loading={saving} loadingLabel="Saving…"
							>Save labels</Button
						>
					</div>
				</form>
			</details>
		{/if}
		<p class="state" aria-live="polite">{answer?.ok ? 'Saved' : ''}</p>
	{/if}
</div>

<style>
	.labels {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.title {
		margin: 0;
		font-size: 13px;
		font-weight: 500;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.none {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
	.none a {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		color: var(--accent);
	}
	@media (pointer: coarse) {
		.none a {
			min-height: 44px;
		}
	}
	summary {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		summary {
			min-height: 44px;
		}
	}
	form {
		display: grid;
		gap: 8px;
		margin-top: 4px;
	}
	fieldset {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 32px;
		min-width: 0;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.check {
			min-height: 44px;
		}
	}
	.check input {
		flex: none;
		width: 18px;
		height: 18px;
		margin: 0;
		accent-color: var(--accent);
	}
	.hint {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}
	.state {
		min-height: 16px;
		margin: 0;
		color: var(--success);
		font-size: 12px;
	}
</style>
