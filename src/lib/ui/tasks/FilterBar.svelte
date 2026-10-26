<!--
	FilterBar: the list and board filters as a GET form (works without JavaScript; the state is the URL). Status and
	priority are checkbox groups (OR inside a group, AND across groups); none ticked means all. Inside a <details>
	so a phone shows one row until it is opened (the summary counts the active filters). The element owns its open
	state: an early tap before hydration is never undone. RB-08: labels (OR inside the set) and milestone (`none`: no
	milestone) when the project has any.
-->
<script lang="ts">
	import {
		TASK_PRIORITIES,
		TASK_PRIORITY_LABELS,
		TASK_STATUSES,
		TASK_STATUS_LABELS
	} from '#lib/shared/enums';
	import Button from '#lib/ui/kit/Button.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import type { LabelColor } from '#lib/shared/enums';
	import LabelChip from '#lib/ui/pm/LabelChip.svelte';
	import type { UserOption } from './options';

	type Assignee = 'any' | 'me' | 'none' | { userId: string };
	let {
		action,
		view,
		filters,
		sort,
		users,
		labels = [],
		milestones = []
	}: {
		action: string;
		view: 'list' | 'board';
		filters: {
			statuses: string[];
			priorities: string[];
			assignee: Assignee;
			labels?: string[];
			milestone?: 'any' | 'none' | { id: string };
		};
		sort: { sort: string; dir: string };
		users: readonly UserOption[];
		labels?: readonly { id: string; name: string; color: LabelColor }[];
		milestones?: readonly { id: string; name: string; status: string }[];
	} = $props();

	const labelFilter = $derived(filters.labels ?? []);
	const milestoneValue = $derived.by(() => {
		const m = filters.milestone ?? 'any';
		return m === 'any' ? '' : m === 'none' ? 'none' : m.id;
	});
	const milestoneOptions = $derived([
		{ value: '', label: 'Any milestone' },
		{ value: 'none', label: 'No milestone' },
		...milestones.map((m) => ({
			value: m.id,
			label: m.status === 'closed' ? `${m.name} (closed)` : m.name
		}))
	]);

	const assigneeValue = $derived(
		typeof filters.assignee === 'string'
			? filters.assignee === 'any'
				? ''
				: filters.assignee
			: filters.assignee.userId
	);
	const active = $derived(
		(filters.statuses.length > 0 ? 1 : 0) +
			(filters.priorities.length > 0 ? 1 : 0) +
			(assigneeValue ? 1 : 0) +
			(labelFilter.length > 0 ? 1 : 0) +
			(milestoneValue ? 1 : 0)
	);
	const assigneeOptions = $derived([
		{ value: '', label: 'Anyone' },
		{ value: 'me', label: 'Me' },
		{ value: 'none', label: 'Unassigned' },
		...users.map((u) => ({ value: u.id, label: u.name }))
	]);
	const SORT_OPTIONS = [
		{ value: 'number', label: 'Number' },
		{ value: 'priority', label: 'Priority' },
		{ value: 'due', label: 'Due date' },
		{ value: 'updated', label: 'Last updated' }
	];
	const DIR_OPTIONS = [
		{ value: 'desc', label: 'Descending' },
		{ value: 'asc', label: 'Ascending' }
	];
	const checked = (list: string[], value: string) => list.length === 0 || list.includes(value);
	const clearHref = $derived(view === 'board' ? `${action}?view=board` : action);
</script>

<details class="filters">
	<summary>
		<span
			>Filters{#if active > 0}<span class="count"> ({active} active)</span>{/if}</span
		>
	</summary>
	<form method="GET" {action} class="body">
		{#if view === 'board'}<input type="hidden" name="view" value="board" />{/if}
		<fieldset>
			<legend>{view === 'board' ? 'Columns' : 'Status'}</legend>
			<div class="checks">
				{#each TASK_STATUSES as s (s)}
					<label class="check"
						><input
							type="checkbox"
							name="status"
							value={s}
							checked={checked(filters.statuses, s)}
						/>{TASK_STATUS_LABELS[s]}</label
					>
				{/each}
			</div>
		</fieldset>
		<fieldset>
			<legend>Priority</legend>
			<div class="checks">
				{#each [...TASK_PRIORITIES].reverse() as p (p)}
					<label class="check"
						><input
							type="checkbox"
							name="priority"
							value={p}
							checked={checked(filters.priorities, p)}
						/>{TASK_PRIORITY_LABELS[p]}</label
					>
				{/each}
			</div>
		</fieldset>
		{#if labels.length > 0}
			<fieldset>
				<legend>Labels</legend>
				<div class="checks">
					{#each labels as l (l.id)}
						<label class="check"
							><input
								type="checkbox"
								name="label"
								value={l.id}
								checked={labelFilter.includes(l.id)}
							/><LabelChip name={l.name} color={l.color} /></label
						>
					{/each}
				</div>
			</fieldset>
		{/if}
		<div class="selects">
			<Select label="Assignee" name="assignee" options={assigneeOptions} value={assigneeValue} />
			{#if milestones.length > 0}
				<Select
					label="Milestone"
					name="milestone"
					options={milestoneOptions}
					value={milestoneValue}
				/>
			{/if}
			{#if view === 'list'}
				<Select label="Sort by" name="sort" options={SORT_OPTIONS} value={sort.sort} />
				<Select label="Order" name="dir" options={DIR_OPTIONS} value={sort.dir} />
			{/if}
		</div>
		<div class="buttons">
			<Button type="submit" variant="primary">Apply</Button>
			<Button href={clearHref} variant="ghost">Clear filters</Button>
		</div>
	</form>
</details>

<style>
	.filters {
		margin-bottom: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		padding: 0 14px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
	}
	.count {
		color: var(--accent);
	}
	.body {
		display: grid;
		gap: 14px;
		padding: 4px 14px 14px;
	}
	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	legend {
		margin-bottom: 6px;
		padding: 0;
		font-size: 13px;
		font-weight: 500;
	}
	.checks {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		padding: 0 10px 0 8px;
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 13px;
		cursor: pointer;
	}
	.check:has(input:checked) {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	@media (pointer: coarse) {
		.check {
			min-height: 44px;
		}
	}
	.check input {
		width: 16px;
		height: 16px;
		margin: 0;
		accent-color: var(--accent);
	}
	.selects {
		display: grid;
		gap: 12px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
