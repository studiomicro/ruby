<!--
	IssueFilters: the Issues page's filters as one GET form (RB-12; the URL is the state, so it works without
	JavaScript). Checkbox groups are OR inside a group and AND across groups; none ticked means all. Labels come in a
	Team group and a project-labels group (with each label's project key). The milestone picker lists milestones only
	when exactly one project is chosen. Rendered inline (a <details>) or inside the phone filter sheet; `idPrefix`
	keeps the two copies' ids apart. The foot (Show results, Clear) sticks to the bottom of a sheet.
-->
<script lang="ts">
	import {
		TASK_PRIORITIES,
		TASK_PRIORITY_LABELS,
		TASK_STATUSES,
		TASK_STATUS_LABELS,
		TASK_TYPES,
		TASK_TYPE_LABELS,
		type LabelColor
	} from '#lib/shared/enums';
	import Button from '#lib/ui/kit/Button.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import Switch from '#lib/ui/kit/Switch.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import LabelChip from '#lib/ui/pm/LabelChip.svelte';

	type Person = 'any' | 'me' | 'none' | { userId: string };
	let {
		filters,
		sort,
		options,
		sticky = false
	}: {
		filters: {
			types: string[];
			statuses: string[];
			priorities: string[];
			labels: string[];
			assignee: Person;
			reporter: Person;
			projects: string[];
			milestone: 'any' | 'none' | { id: string };
			createdFrom: string | null;
			createdTo: string | null;
			updatedFrom: string | null;
			updatedTo: string | null;
			archived: boolean;
		};
		sort: { sort: string; dir: string };
		options: {
			projects: readonly { key: string; name: string; status: string }[];
			users: readonly { id: string; name: string }[];
			teamLabels: readonly { id: string; name: string; color: LabelColor }[];
			projectLabels: readonly { id: string; name: string; color: LabelColor; projectKey: string }[];
			moreProjectLabels: boolean;
			milestones: readonly { id: string; name: string; status: string }[];
		};
		/** In the phone sheet: the buttons stick to its foot. */
		sticky?: boolean;
	} = $props();

	const ticked = (list: string[], value: string) => list.length === 0 || list.includes(value);
	const personValue = (p: Person) => (p === 'any' ? '' : typeof p === 'string' ? p : p.userId);
	const people = $derived(options.users.map((u) => ({ value: u.id, label: u.name })));
	const assigneeOptions = $derived([
		{ value: '', label: 'Anyone' },
		{ value: 'me', label: 'Me' },
		{ value: 'none', label: 'Unassigned' },
		...people
	]);
	const reporterOptions = $derived([
		{ value: '', label: 'Anyone' },
		{ value: 'me', label: 'Me' },
		...people
	]);
	const milestoneValue = $derived(
		filters.milestone === 'any' ? '' : filters.milestone === 'none' ? 'none' : filters.milestone.id
	);
	const milestoneOptions = $derived([
		{ value: '', label: 'Any milestone' },
		{ value: 'none', label: 'No milestone' },
		...(filters.projects.length === 1
			? options.milestones.map((m) => ({
					value: m.id,
					label: m.status === 'closed' ? `${m.name} (closed)` : m.name
				}))
			: [])
	]);
	const SORTS = [
		{ value: 'updated', label: 'Last updated' },
		{ value: 'created', label: 'Created' },
		{ value: 'priority', label: 'Priority' },
		{ value: 'due', label: 'Due date' }
	];
	const DIRS = [
		{ value: 'desc', label: 'Descending' },
		{ value: 'asc', label: 'Ascending' }
	];
</script>

<form method="GET" action="/issues" class="filters">
	<fieldset>
		<legend>Type</legend>
		<div class="checks">
			{#each TASK_TYPES as t (t)}
				<label class="check"
					><input
						type="checkbox"
						name="type"
						value={t}
						checked={ticked(filters.types, t)}
					/>{TASK_TYPE_LABELS[t]}</label
				>
			{/each}
		</div>
	</fieldset>
	<fieldset>
		<legend>Status</legend>
		<div class="checks">
			{#each TASK_STATUSES as s (s)}
				<label class="check"
					><input
						type="checkbox"
						name="status"
						value={s}
						checked={ticked(filters.statuses, s)}
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
						checked={ticked(filters.priorities, p)}
					/>{TASK_PRIORITY_LABELS[p]}</label
				>
			{/each}
		</div>
	</fieldset>
	{#if options.projects.length > 0}
		<fieldset>
			<legend>Projects <span class="hint">(up to 6)</span></legend>
			<div class="checks">
				{#each options.projects as p (p.key)}
					{#if p.status === 'active' || filters.archived}
						<label class="check"
							><input
								type="checkbox"
								name="project"
								value={p.key}
								checked={filters.projects.includes(p.key)}
							/><span class="key">{p.key}</span><span class="sr-only">
								{p.name}</span
							>{#if p.status === 'archived'}<span class="hint"> (archived)</span>{/if}</label
						>
					{/if}
				{/each}
			</div>
		</fieldset>
	{/if}
	{#if options.teamLabels.length > 0}
		<fieldset>
			<legend>Team labels</legend>
			<div class="checks">
				{#each options.teamLabels as l (l.id)}
					<label class="check"
						><input
							type="checkbox"
							name="label"
							value={l.id}
							checked={filters.labels.includes(l.id)}
						/><LabelChip name={l.name} color={l.color} scope="team" /></label
					>
				{/each}
			</div>
		</fieldset>
	{/if}
	{#if options.projectLabels.length > 0}
		<fieldset>
			<legend>Project labels</legend>
			<div class="checks">
				{#each options.projectLabels as l (l.id)}
					<label class="check"
						><input
							type="checkbox"
							name="label"
							value={l.id}
							checked={filters.labels.includes(l.id)}
						/><span class="key">{l.projectKey}</span><LabelChip
							name={l.name}
							color={l.color}
						/></label
					>
				{/each}
			</div>
			{#if options.moreProjectLabels}<p class="hint">Narrow by project to see more labels.</p>{/if}
		</fieldset>
	{/if}
	<div class="selects">
		<Select
			label="Assignee"
			name="assignee"
			options={assigneeOptions}
			value={personValue(filters.assignee)}
		/>
		<Select
			label="Reporter"
			name="reporter"
			options={reporterOptions}
			value={personValue(filters.reporter)}
		/>
		<Select
			label="Milestone"
			name="milestone"
			options={milestoneOptions}
			value={milestoneValue}
			hint={filters.projects.length === 1 ? undefined : 'Choose one project to pick a milestone.'}
		/>
	</div>
	<fieldset>
		<legend>Created</legend>
		<div class="dates">
			<TextField label="From" name="created_from" type="date" value={filters.createdFrom ?? ''} />
			<TextField label="To" name="created_to" type="date" value={filters.createdTo ?? ''} />
		</div>
	</fieldset>
	<fieldset>
		<legend>Updated</legend>
		<div class="dates">
			<TextField label="From" name="updated_from" type="date" value={filters.updatedFrom ?? ''} />
			<TextField label="To" name="updated_to" type="date" value={filters.updatedTo ?? ''} />
		</div>
	</fieldset>
	<Switch label="Include archived projects" name="archived" value="1" checked={filters.archived} />
	<div class="selects">
		<Select label="Sort by" name="sort" options={SORTS} value={sort.sort} />
		<Select label="Order" name="dir" options={DIRS} value={sort.dir} />
	</div>
	<div class="buttons" class:sticky>
		<Button type="submit" variant="primary">Show results</Button>
		<Button href="/issues" variant="ghost">Clear filters</Button>
	</div>
</form>

<style>
	.filters {
		display: grid;
		gap: 14px;
		min-width: 0;
	}
	fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 6px;
		padding: 0;
		font-size: 13px;
		font-weight: 500;
	}
	.hint {
		margin: 4px 0 0;
		color: var(--muted);
		font-size: 12px;
		font-weight: 400;
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
		max-width: 100%;
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
		flex: none;
		width: 16px;
		height: 16px;
		margin: 0;
	}
	.key {
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.selects,
	.dates {
		display: grid;
		gap: 12px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.buttons.sticky {
		position: sticky;
		bottom: 0;
		margin: 0 -2px;
		padding: 10px 2px 2px;
		border-top: 1px solid var(--border);
		background: var(--surface);
	}
</style>
