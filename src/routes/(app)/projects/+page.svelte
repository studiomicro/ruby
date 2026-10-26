<script lang="ts">
	import { navigating } from '$app/state';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Assignee from '#lib/ui/tasks/Assignee.svelte';

	let { data } = $props();
	const loading = $derived(navigating.to?.route.id === '/(app)/projects');
</script>

<PageHeader
	title={data.archived ? 'Archived projects' : 'Projects'}
	description={data.archived
		? 'Read-only projects. Unarchive one from its settings.'
		: 'Every project of the team, with its open tasks.'}
>
	{#snippet actions()}
		<Button href={data.archived ? '/projects' : '/projects?archived=1'} variant="ghost"
			>{data.archived ? 'Active projects' : 'Archived'}</Button
		>
		<Button href="/projects/new" variant="primary">New project</Button>
	{/snippet}
</PageHeader>

{#if loading}
	<ul class="rows skeleton" aria-busy="true" aria-label="Loading projects">
		{#each [0, 1, 2] as i (i)}<li class="row"><span class="bar"></span></li>{/each}
	</ul>
{:else if data.projects.length === 0}
	{#if data.archived}
		<EmptyState title="No archived projects" description="Archived projects show up here." />
	{:else}
		<EmptyState
			title="No projects yet"
			description="A project holds numbered tasks you can see as a list or a board."
			action={{ href: '/projects/new', label: 'Create your first project' }}
		/>
	{/if}
{:else}
	<ul class="rows">
		<li class="row head" aria-hidden="true">
			<span>Key</span><span>Name</span><span>Lead</span><span class="num">Open</span><span
				>Updated</span
			>
		</li>
		{#each data.projects as project (project.id)}
			<li class="row">
				<span class="key"><Badge tone="accent">{project.key}</Badge></span>
				<a class="name" href="/projects/{project.key}">{project.name}</a>
				<span class="lead"
					><span class="label">Lead</span>
					{#if project.leadId}<Assignee id={project.leadId} name={project.leadName} />{:else}<span
							class="muted">No lead</span
						>{/if}</span
				>
				<span class="num"
					>{project.open}<span class="label">
						open {project.open === 1 ? 'task' : 'tasks'}</span
					></span
				>
				<span class="updated"
					><span class="label">Updated </span><LocalTime at={project.updatedAt} /></span
				>
			</li>
		{/each}
	</ul>
{/if}

<style>
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
		grid-template-columns: auto minmax(0, 1fr);
		gap: 4px 10px;
		align-items: center;
		padding: 12px 14px;
		font-size: 13px;
		color: var(--muted);
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.head {
		display: none;
	}
	.name {
		color: var(--fg);
		font-size: 15px;
		font-weight: 500;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	/* The whole row is the link's target (≥ 44 px), without nesting interactive content. */
	.name::after {
		content: '';
		position: absolute;
		inset: 0;
	}
	.name:hover {
		text-decoration: underline;
	}
	@media (pointer: coarse) {
		.name {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}
	}
	.lead,
	.num,
	.updated {
		grid-column: 2;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.label {
		color: var(--subtle);
	}
	.lead .label {
		display: none;
	}
	.muted {
		color: var(--subtle);
	}
	.skeleton .bar {
		display: block;
		height: 18px;
		border-radius: 4px;
		background: var(--surface-2);
		grid-column: 1 / -1;
	}
	@media (min-width: 768px) {
		.row {
			grid-template-columns: 90px minmax(0, 2fr) minmax(0, 1.2fr) 70px 110px;
			gap: 12px;
		}
		.head {
			display: grid;
			padding-block: 8px;
			font-size: 12px;
			font-weight: 500;
			color: var(--muted);
		}
		.lead,
		.num,
		.updated {
			grid-column: auto;
		}
		.num {
			justify-content: flex-end;
			font-variant-numeric: tabular-nums;
		}
		.num .label,
		.updated .label {
			display: none;
		}
	}
</style>
