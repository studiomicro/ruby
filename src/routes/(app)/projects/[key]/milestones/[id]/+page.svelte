<script lang="ts">
	import { TASK_STATUSES, TASK_STATUS_LABELS } from '#lib/shared/enums';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import { formatDue } from '#lib/ui/tasks/options';

	let { data } = $props();
	const base = $derived(`/projects/${data.project.key}`);
	const m = $derived(data.milestone);
	const groups = $derived(
		TASK_STATUSES.map((status) => ({
			status,
			tasks: data.tasks.filter((t) => t.status === status)
		})).filter((g) => g.tasks.length > 0)
	);
	const overdue = $derived(m.status === 'open' && !!m.dueOn && m.dueOn < data.today);
</script>

<svelte:head><title>{m.name} · {data.project.key} · Ruby</title></svelte:head>

<section class="milestone" aria-labelledby="milestone-heading">
	<div class="head">
		<h2 id="milestone-heading">{m.name}</h2>
		<Badge tone={m.status === 'open' ? 'accent' : 'neutral'}
			>{m.status === 'open' ? 'Open' : 'Closed'}</Badge
		>
		{#if m.dueOn}
			<span class="due" class:overdue
				>{overdue ? 'Overdue, was due' : 'Due'} {formatDue(m.dueOn, data.today)}</span
			>
		{/if}
	</div>
	{#if m.description}<p class="description">{m.description}</p>{/if}

	<div class="progress">
		<progress value={data.progress.done} max={Math.max(data.progress.total, 1)} aria-label="Done"
		></progress>
		<p>
			{data.progress.done} of {data.progress.total} tasks done ({data.progress.percent}%)
			{#if data.progress.byStatus.canceled > 0}
				· {data.progress.byStatus.canceled} canceled not counted{/if}
		</p>
	</div>

	<div class="actions">
		<Button href="{base}?milestone={m.id}" size="sm">Open in the list</Button>
		<Button href="{base}?view=board&milestone={m.id}" size="sm">Open on the board</Button>
		<Button href="{base}/settings" size="sm" variant="ghost">Manage milestones</Button>
	</div>
</section>

{#if data.tasks.length === 0}
	<EmptyState
		title="No tasks in this milestone"
		description="Set the milestone on a task, or select tasks in the list and use bulk edit."
	/>
{:else}
	<div class="groups">
		{#each groups as g (g.status)}
			<section aria-labelledby="ms-{g.status}">
				<h3 id="ms-{g.status}">
					{TASK_STATUS_LABELS[g.status]} <span class="count">{g.tasks.length}</span>
				</h3>
				<ul class="rows">
					{#each g.tasks as t (t.id)}
						<li>
							<a href="{base}/tasks/{t.number}"
								><span class="ref">{data.project.key}-{t.number}</span>
								<span class="title">{t.title}</span></a
							>
							{#if t.assigneeName}<span class="who">{t.assigneeName}</span>{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	</div>
{/if}

<style>
	.milestone {
		display: grid;
		gap: 12px;
		margin-bottom: 20px;
		padding: 18px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	@media (max-width: 420px) {
		.milestone {
			padding: 14px;
		}
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
	}
	h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.due {
		color: var(--muted);
		font-size: 13px;
	}
	.due.overdue {
		color: var(--danger);
	}
	.description {
		margin: 0;
		font-size: 14px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.progress {
		display: grid;
		gap: 6px;
	}
	.progress p {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
	progress {
		width: 100%;
		height: 8px;
		border: 0;
		border-radius: 999px;
		background: var(--surface-3);
		overflow: hidden;
		appearance: none;
	}
	progress::-webkit-progress-bar {
		background: var(--surface-3);
	}
	progress::-webkit-progress-value {
		background: var(--success);
	}
	progress::-moz-progress-bar {
		background: var(--success);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.groups {
		display: grid;
		gap: 18px;
	}
	h3 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 8px;
		font-size: 14px;
		font-weight: 600;
	}
	.count {
		color: var(--muted);
		font-weight: 400;
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.rows li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 10px;
		padding: 0 14px;
	}
	.rows li + li {
		border-top: 1px solid var(--border);
	}
	.rows a {
		display: inline-flex;
		flex: 1 1 auto;
		align-items: center;
		gap: 8px;
		min-width: 0;
		min-height: 44px;
		color: var(--fg);
		text-decoration: none;
	}
	.rows a:hover .title {
		text-decoration: underline;
	}
	.ref {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 12px;
		white-space: nowrap;
	}
	.title {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.who {
		color: var(--muted);
		font-size: 13px;
	}
</style>
