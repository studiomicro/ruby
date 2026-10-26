<script lang="ts">
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Due from '#lib/ui/tasks/Due.svelte';
	import Priority from '#lib/ui/tasks/Priority.svelte';
	import StatusBadge from '#lib/ui/tasks/StatusBadge.svelte';
	import LabelChip from '#lib/ui/pm/LabelChip.svelte';

	let { data } = $props();
	const sections = $derived([
		{ id: 'overdue', title: 'Overdue', rows: data.groups.overdue },
		{ id: 'today', title: 'Today', rows: data.groups.today },
		{ id: 'upcoming', title: 'Upcoming', rows: data.groups.upcoming },
		{ id: 'none', title: 'No due date', rows: data.groups.none },
		...(data.showClosed ? [{ id: 'closed', title: 'Closed', rows: data.closed }] : [])
	]);
	const openCount = $derived(
		data.groups.overdue.length +
			data.groups.today.length +
			data.groups.upcoming.length +
			data.groups.none.length
	);
</script>

<PageHeader title="My tasks" description="Open tasks assigned to you, by due date.">
	{#snippet actions()}
		<Button href={data.showClosed ? '/my-tasks' : '/my-tasks?closed=1'} variant="ghost"
			>{data.showClosed ? 'Hide closed' : 'Show closed'}</Button
		>
	{/snippet}
</PageHeader>

{#if openCount === 0 && (!data.showClosed || data.closed.length === 0)}
	<EmptyState
		title="Nothing assigned to you"
		description="Tasks assigned to you in any project show up here."
		action={{ href: '/projects', label: 'Open projects' }}
	/>
{:else}
	<div class="sections">
		{#each sections as section (section.id)}
			{#if section.rows.length > 0}
				<section aria-labelledby="sec-{section.id}">
					<h2 id="sec-{section.id}" class:danger={section.id === 'overdue'}>
						{section.title} <span class="count">{section.rows.length}</span>
					</h2>
					<ul class="rows">
						{#each section.rows as task (task.id)}
							<li class="row">
								<span class="ref">{task.projectKey}-{task.number}</span>
								<a class="title" href="/projects/{task.projectKey}/tasks/{task.number}"
									><span class="sr-only">{task.projectKey}-{task.number}: </span>{task.title}</a
								>
								<span class="meta">
									<StatusBadge status={task.status} />
									<Priority priority={task.priority} />
									<Due dueOn={task.dueOn} status={task.status} today={data.today} empty="" />
									{#if task.projectStatus === 'archived'}<Badge tone="warning">Archived</Badge>{/if}
									{#if task.milestoneName}<span class="milestone"
											><span class="sr-only">Milestone: </span>◆ {task.milestoneName}</span
										>{/if}
									{#each task.labels as l (l.id)}<LabelChip name={l.name} color={l.color} />{/each}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.milestone {
		color: var(--muted);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.sections {
		display: grid;
		gap: 22px;
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 8px;
		font-size: 14px;
		font-weight: 600;
		color: var(--muted);
	}
	h2.danger {
		color: var(--danger);
	}
	.count {
		min-width: 20px;
		padding: 0 6px;
		border-radius: 999px;
		background: var(--surface-3);
		color: var(--muted);
		font-size: 12px;
		line-height: 20px;
		text-align: center;
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.row {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 4px 12px;
		padding: 11px 14px;
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.ref {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.title {
		color: var(--fg);
		font-weight: 500;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.title::after {
		content: '';
		position: absolute;
		inset: 0;
	}
	.title:hover {
		text-decoration: underline;
	}
	@media (pointer: coarse) {
		.title {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	@media (min-width: 768px) {
		.row {
			grid-template-columns: 90px minmax(0, 1fr) auto;
			align-items: center;
		}
	}
</style>
