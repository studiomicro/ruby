<!--
	IssueTable: the Issues page's rows (RB-12). From 768 px a kit Table (key with the type, title with label chips,
	project, status, priority, assignee, updated); below it the same rows stacked (title on top, then type, status,
	priority, project, assignee and due date as chips), so the page never scrolls sideways. With `selectForm` each row
	gets a checkbox (a 44 px target on touch) that belongs to the bulk form by id, so bulk edit works without
	JavaScript. Titles and label names are plain text.
-->
<script lang="ts">
	import type { LabelColor, TaskPriority, TaskStatus, TaskType } from '#lib/shared/enums';
	import Avatar from '#lib/ui/kit/Avatar.svelte';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import Table from '#lib/ui/kit/Table.svelte';
	import LabelChip from '#lib/ui/pm/LabelChip.svelte';
	import Assignee from '#lib/ui/tasks/Assignee.svelte';
	import Due from '#lib/ui/tasks/Due.svelte';
	import Priority from '#lib/ui/tasks/Priority.svelte';
	import StatusBadge from '#lib/ui/tasks/StatusBadge.svelte';
	import TypeBadge from './TypeBadge.svelte';

	type Row = {
		id: string;
		number: number;
		title: string;
		type: TaskType;
		status: TaskStatus;
		priority: TaskPriority;
		assigneeId: string | null;
		assigneeName: string | null;
		dueOn: string | null;
		updatedAt: number;
		projectKey: string;
		projectArchived: boolean;
		labels: { id: string; name: string; color: LabelColor; scope: 'project' | 'team' }[];
	};
	let {
		rows,
		today,
		selectForm,
		selected,
		onselect
	}: {
		rows: readonly Row[];
		today: string;
		selectForm?: string;
		selected?: ReadonlySet<string>;
		onselect?: (id: string, checked: boolean) => void;
	} = $props();

	const href = (r: Row) => `/projects/${r.projectKey}/tasks/${r.number}`;
	const ref = (r: Row) => `${r.projectKey}-${r.number}`;
	/** A selectable row: not in an archived project (bulk refuses those anyway). */
	const pickable = (r: Row) => selectForm !== undefined && !r.projectArchived;
</script>

{#snippet pick(r: Row)}
	{#if pickable(r)}
		<label class="pick-box"
			><input
				type="checkbox"
				name="taskId"
				value={r.id}
				form={selectForm}
				checked={selected?.has(r.id) ?? false}
				onchange={(e) => onselect?.(r.id, e.currentTarget.checked)}
			/><span class="sr-only">Select {ref(r)}</span></label
		>
	{/if}
{/snippet}

{#snippet chips(r: Row)}
	{#each r.labels as l (l.id)}<LabelChip name={l.name} color={l.color} scope={l.scope} />{/each}
{/snippet}

<div class="wide">
	<Table caption="Issues" compact>
		<thead>
			<tr>
				{#if selectForm}<th scope="col" class="pick"><span class="sr-only">Select</span></th>{/if}
				<th scope="col">ID</th>
				<th scope="col">Title</th>
				<th scope="col">Project</th>
				<th scope="col">Status</th>
				<th scope="col">Priority</th>
				<th scope="col">Assignee</th>
				<th scope="col">Updated</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r (r.id)}
				<tr class:picked={selected?.has(r.id)}>
					{#if selectForm}<td class="pick">{@render pick(r)}</td>{/if}
					<td class="ref"><span class="key">{ref(r)}</span><TypeBadge type={r.type} /></td>
					<td class="title"
						><a href={href(r)}><span class="sr-only">{ref(r)}: </span>{r.title}</a>
						{#if r.labels.length > 0}<span class="labels">{@render chips(r)}</span>{/if}</td
					>
					<td
						>{r.projectKey}{#if r.projectArchived}
							<Badge tone="warning">Archived</Badge>{/if}</td
					>
					<td><StatusBadge status={r.status} /></td>
					<td><Priority priority={r.priority} /></td>
					<td><Assignee id={r.assigneeId} name={r.assigneeName} /></td>
					<td class="when"><LocalTime at={r.updatedAt} /></td>
				</tr>
			{/each}
		</tbody>
	</Table>
</div>

<ul class="narrow" aria-label="Issues">
	{#each rows as r (r.id)}
		<li class="row" class:picked={selected?.has(r.id)}>
			{@render pick(r)}
			<div class="main">
				<a class="row-title" href={href(r)}><span class="key">{ref(r)}</span> {r.title}</a>
				<div class="meta">
					<TypeBadge type={r.type} />
					<StatusBadge status={r.status} />
					<Priority priority={r.priority} compact />
					<Badge>{r.projectKey}</Badge>
					{#if r.projectArchived}<Badge tone="warning">Archived</Badge>{/if}
					{#if r.assigneeId && r.assigneeName}<span class="who"
							><Avatar
								name={r.assigneeName}
								seed={r.assigneeId}
								size="sm"
								decorative={false}
							/></span
						>{/if}
					<Due dueOn={r.dueOn} status={r.status} {today} empty="" />
					{@render chips(r)}
				</div>
			</div>
		</li>
	{/each}
</ul>

<style>
	.wide {
		display: none;
	}
	.narrow {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	@media (min-width: 768px) {
		.wide {
			display: block;
		}
		.narrow {
			display: none;
		}
	}
	a {
		color: var(--fg);
		text-decoration: none;
	}
	a:hover {
		text-decoration: underline;
	}
	.key {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 12px;
		white-space: nowrap;
	}
	.ref {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 1%;
	}
	.title {
		min-width: 220px;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.labels {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
		font-weight: 400;
	}
	.when {
		color: var(--muted);
		font-size: 13px;
		white-space: nowrap;
	}
	th.pick,
	td.pick {
		width: 1%;
		padding-right: 0;
	}
	tr.picked,
	li.picked {
		background: var(--accent-soft);
	}
	.pick-box {
		display: grid;
		flex: none;
		place-items: center;
		width: 32px;
		height: 32px;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.pick-box {
			width: 44px;
			height: 44px;
		}
	}
	.pick-box input {
		width: 18px;
		height: 18px;
		margin: 0;
	}
	.row {
		display: flex;
		align-items: flex-start;
		gap: 4px;
		min-width: 0;
		padding: 10px 12px;
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.row .pick-box {
		margin: -6px 0 0 -8px;
	}
	.main {
		display: grid;
		flex: 1;
		gap: 6px;
		min-width: 0;
	}
	.row-title {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 6px;
		min-height: 32px;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	@media (pointer: coarse) {
		.row-title {
			min-height: 44px;
		}
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		min-width: 0;
	}
	.who {
		display: inline-flex;
	}
</style>
