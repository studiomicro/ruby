<!--
	BulkBar: the list view's bulk edit form (RB-08). The row checkboxes belong to it by `form` id, so it works without
	JavaScript (then it is always shown). With JavaScript it appears once a row is selected, shows "N selected",
	keeps Apply disabled until a change is chosen, and clears the selection after the server confirms. Every control is
	a native select, input or button (≥ 44 px on touch); nothing depends on hover.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import type { LabelColor } from '#lib/shared/enums';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import { PRIORITY_OPTIONS, STATUS_OPTIONS, type UserOption } from '#lib/ui/tasks/options';
	import type { PmAnswer } from './answer';

	let {
		id,
		action,
		selectedCount,
		pageCount,
		onselectall,
		oncleared,
		users,
		milestones,
		labels,
		answer
	}: {
		id: string;
		action: string;
		selectedCount: number;
		/** Rows on this page (the "select all" checkbox). */
		pageCount: number;
		onselectall: (checked: boolean) => void;
		/** After a confirmed write: the page clears its selection. */
		oncleared: () => void;
		users: readonly UserOption[];
		milestones: readonly { id: string; name: string; status: string }[];
		labels: readonly { id: string; name: string; color: LabelColor }[];
		answer: PmAnswer | null;
	} = $props();

	let mounted = $state(false);
	onMount(() => (mounted = true));
	let saving = $state(false);
	let changed = $state(false);
	let formEl = $state<HTMLFormElement>();

	const keep = { value: '', label: 'No change' };
	const statusOptions = [keep, ...STATUS_OPTIONS];
	const priorityOptions = [keep, ...PRIORITY_OPTIONS];
	const assigneeOptions = $derived([
		keep,
		{ value: 'none', label: 'Unassign' },
		...users.map((u) => ({ value: u.id, label: u.name }))
	]);
	const milestoneOptions = $derived([
		keep,
		{ value: 'none', label: 'Clear milestone' },
		...milestones.filter((m) => m.status === 'open').map((m) => ({ value: m.id, label: m.name }))
	]);
	const labelOptions = $derived([
		{ value: '', label: 'None' },
		...labels.map((l) => ({ value: l.id, label: l.name }))
	]);
	const errors = $derived(answer && !answer.ok ? (answer.errors ?? {}) : {});

	/** Whether any change control has a value (Apply stays disabled until one does). */
	function recompute() {
		if (!formEl) return;
		const data = new FormData(formEl);
		changed = [
			'status',
			'priority',
			'assigneeId',
			'milestoneId',
			'dueOn',
			'addLabelId',
			'removeLabelId',
			'clearDue'
		].some((name) => {
			const v = data.get(name);
			return typeof v === 'string' && v !== '';
		});
	}
	const shown = $derived(!mounted || selectedCount > 0 || (answer !== null && !answer.ok));
</script>

<Banner tone="success" message={answer?.ok ? answer.message : null} />

<section class="bulk" class:hidden={!shown} aria-labelledby="{id}-title" id="{id}-panel">
	<form
		{id}
		method="POST"
		{action}
		bind:this={formEl}
		oninput={recompute}
		onchange={recompute}
		use:enhance={() => {
			saving = true;
			return async ({ result, update }) => {
				await update();
				saving = false;
				if (result.type === 'success') {
					changed = false;
					oncleared();
				}
			};
		}}
	>
		<div class="head">
			<h2 id="{id}-title">
				{#if mounted}{selectedCount} selected{:else}Edit selected tasks{/if}
			</h2>
			{#if mounted && pageCount > 0}
				<label class="all"
					><input
						type="checkbox"
						checked={selectedCount === pageCount}
						onchange={(e) => onselectall(e.currentTarget.checked)}
					/> Select all on this page</label
				>
			{/if}
		</div>
		<Banner tone="error" message={answer && !answer.ok ? answer.message : null} />
		<div class="grid">
			<Select label="Set status" name="status" options={statusOptions} error={errors.status} />
			<Select
				label="Set priority"
				name="priority"
				options={priorityOptions}
				error={errors.priority}
			/>
			<Select
				label="Assign to"
				name="assigneeId"
				options={assigneeOptions}
				error={errors.assigneeId}
			/>
			{#if milestones.length > 0}
				<Select
					label="Set milestone"
					name="milestoneId"
					options={milestoneOptions}
					error={errors.milestoneId}
				/>
			{/if}
			<div class="due">
				<TextField label="Set due date" name="dueOn" type="date" error={errors.dueOn} />
				<label class="clear"><input type="checkbox" name="clearDue" /> Clear due date</label>
			</div>
			{#if labels.length > 0}
				<Select
					label="Add label"
					name="addLabelId"
					options={labelOptions}
					error={errors.addLabelId}
				/>
				<Select
					label="Remove label"
					name="removeLabelId"
					options={labelOptions}
					error={errors.removeLabelId}
				/>
			{/if}
		</div>
		<p class="note">Bulk changes overwrite what others changed meanwhile.</p>
		<div class="buttons">
			<Button
				type="submit"
				variant="primary"
				disabled={mounted && (!changed || selectedCount === 0)}
				loading={saving}
				loadingLabel="Updating…">Update selected tasks</Button
			>
			{#if mounted && selectedCount > 0}
				<Button variant="ghost" onclick={() => onselectall(false)}>Clear selection</Button>
			{/if}
		</div>
	</form>
</section>

<style>
	.bulk {
		margin-bottom: 12px;
		padding: 14px;
		border: 1px solid var(--accent);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.bulk.hidden {
		display: none;
	}
	form {
		display: grid;
		gap: 12px;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 4px 12px;
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.all,
	.clear {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 36px;
		font-size: 14px;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.all,
		.clear {
			min-height: 44px;
		}
	}
	.all input,
	.clear input {
		width: 18px;
		height: 18px;
		margin: 0;
		accent-color: var(--accent);
	}
	.grid {
		display: grid;
		gap: 12px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
	}
	.due {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.note {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
