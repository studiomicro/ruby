<!--
	TaskTable: a project's tasks as a table (≥ 768 px) that collapses to stacked rows on a phone. Every row links to
	the task; overdue due dates are red only for open tasks. RB-08: label chips, the milestone and checklist progress;
	with `selectForm` every row gets a checkbox (a ≥ 44 px target above the row link) that belongs to that form by id,
	so the bulk form works without JavaScript.
-->
<script lang="ts">
	import type { LabelColor, TaskPriority, TaskStatus, TaskType } from '#lib/shared/enums';
	import TypeBadge from '#lib/ui/issues/TypeBadge.svelte';
	import ChecklistProgress from '#lib/ui/pm/ChecklistProgress.svelte';
	import LabelChip from '#lib/ui/pm/LabelChip.svelte';
	import Assignee from './Assignee.svelte';
	import Due from './Due.svelte';
	import Priority from './Priority.svelte';
	import StatusBadge from './StatusBadge.svelte';

	type Row = {
		id: string;
		number: number;
		title: string;
		status: TaskStatus;
		priority: TaskPriority;
		assigneeId: string | null;
		assigneeName: string | null;
		dueOn: string | null;
		milestoneId?: string | null;
		milestoneName?: string | null;
		labels?: { id: string; name: string; color: LabelColor; scope?: 'project' | 'team' }[];
		/** RB-12: shown next to the title unless it is the quiet default `task`. */
		type?: TaskType;
		checklist?: { done: number; total: number } | null;
	};
	let {
		rows,
		projectKey,
		today,
		selectForm,
		selected,
		onselect
	}: {
		rows: readonly Row[];
		projectKey: string;
		today: string;
		/** The id of the bulk form the row checkboxes belong to (none: no checkboxes). */
		selectForm?: string;
		selected?: ReadonlySet<string>;
		onselect?: (id: string, checked: boolean) => void;
	} = $props();
</script>

<table class="tasks">
	<thead>
		<tr>
			{#if selectForm}<th scope="col" class="pick"><span class="sr-only">Select</span></th>{/if}
			<th scope="col">ID</th>
			<th scope="col">Title</th>
			<th scope="col">Status</th>
			<th scope="col">Priority</th>
			<th scope="col">Assignee</th>
			<th scope="col">Due</th>
			<th scope="col">Details</th>
		</tr>
	</thead>
	<tbody>
		{#each rows as task (task.id)}
			<tr class:picked={selected?.has(task.id)}>
				{#if selectForm}
					<td class="pick"
						><label class="pick-box"
							><input
								type="checkbox"
								name="taskId"
								value={task.id}
								form={selectForm}
								checked={selected?.has(task.id) ?? false}
								onchange={(e) => onselect?.(task.id, e.currentTarget.checked)}
							/><span class="sr-only">Select {projectKey}-{task.number}</span></label
						></td
					>
				{/if}
				<td class="ref" aria-hidden="true">{projectKey}-{task.number}</td>
				<td class="title"
					><a href="/projects/{projectKey}/tasks/{task.number}"
						><span class="sr-only">{projectKey}-{task.number}: </span>{task.title}</a
					>{#if task.type && task.type !== 'task'}
						<span class="type-badge"><TypeBadge type={task.type} /></span>{/if}</td
				>
				<td class="status"><StatusBadge status={task.status} /></td>
				<td class="prio"><Priority priority={task.priority} /></td>
				<td class="who"><Assignee id={task.assigneeId} name={task.assigneeName} /></td>
				<td class="due"><Due dueOn={task.dueOn} status={task.status} {today} empty="" /></td>
				<td class="extra">
					{#if task.milestoneId && task.milestoneName}
						<a class="milestone" href="/projects/{projectKey}/milestones/{task.milestoneId}"
							><span class="sr-only">Milestone: </span>◆ {task.milestoneName}</a
						>
					{/if}
					<ChecklistProgress progress={task.checklist ?? null} />
					{#each task.labels ?? [] as label (label.id)}<LabelChip
							name={label.name}
							color={label.color}
							scope={label.scope}
						/>{/each}
				</td>
			</tr>
		{/each}
	</tbody>
</table>

<style>
	.tasks {
		width: 100%;
		border-collapse: separate;
		border-spacing: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
		font-size: 14px;
	}
	a {
		color: var(--fg);
		text-decoration: none;
	}
	.title a:hover {
		text-decoration: underline;
	}
	.ref {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 12px;
		white-space: nowrap;
	}

	/* Phone: one stacked block per task; the title link covers the whole row (a ≥ 44 px target). */
	thead {
		display: none;
	}
	tbody,
	tr,
	td {
		display: block;
	}
	tr {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		padding: 12px 14px;
	}
	tr + tr {
		border-top: 1px solid var(--border);
	}
	td {
		min-width: 0;
		padding: 0;
	}
	.title {
		order: 1;
		flex: 1 0 100%;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.type-badge {
		display: inline-flex;
		margin-left: 6px;
		vertical-align: middle;
	}
	.title a::after {
		content: '';
		position: absolute;
		inset: 0;
	}
	@media (pointer: coarse) {
		.title a {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}
	}
	.status,
	.prio,
	.who,
	.due,
	.extra {
		order: 2;
	}
	.extra {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		min-width: 0;
	}
	.extra:empty {
		display: none;
	}
	.milestone {
		position: relative;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		color: var(--muted);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.milestone:hover {
		color: var(--fg);
		text-decoration: underline;
	}
	@media (pointer: coarse) {
		.milestone {
			min-height: 44px;
		}
	}
	/* The checkbox sits above the row link (which covers the row on a phone). */
	.pick {
		order: 0;
		position: relative;
		z-index: 1;
	}
	.pick-box {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		margin: -10px -6px -10px -10px;
		cursor: pointer;
	}
	.pick-box input {
		width: 18px;
		height: 18px;
		margin: 0;
		accent-color: var(--accent);
	}
	tr.picked {
		background: var(--accent-soft);
	}
	.ref {
		flex: 1 0 auto;
		order: 0;
	}

	@media (min-width: 768px) {
		thead {
			display: table-header-group;
		}
		tbody {
			display: table-row-group;
		}
		tr {
			display: table-row;
		}
		td,
		th {
			display: table-cell;
			padding: 9px 12px;
			vertical-align: middle;
			text-align: left;
		}
		th {
			color: var(--muted);
			font-size: 12px;
			font-weight: 500;
			border-bottom: 1px solid var(--border);
		}
		tbody tr + tr td {
			border-top: 1px solid var(--border);
		}
		tbody tr:hover td {
			background: var(--surface-2);
		}
		.title a::after {
			content: none;
		}
		.ref {
			width: 1%;
		}
		.title {
			width: 40%;
		}
		td.pick,
		th.pick {
			width: 1%;
			padding-right: 0;
		}
		.pick-box {
			width: 32px;
			height: 32px;
			margin: -6px -6px;
		}
		td.extra {
			display: table-cell;
		}
		.extra > :global(*) + :global(*) {
			margin-left: 6px;
		}
		.milestone {
			min-height: 0;
		}
	}
	@media (min-width: 768px) and (pointer: coarse) {
		.pick-box {
			width: 44px;
			height: 44px;
			margin: -12px -8px;
		}
	}
</style>
