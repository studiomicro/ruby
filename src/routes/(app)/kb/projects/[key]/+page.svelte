<script lang="ts">
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import ScopeNav from '../../ScopeNav.svelte';
	import ScopeTreeView from '../../ScopeTreeView.svelte';

	let { data } = $props();
	const newHref = $derived(`/kb/new?project=${encodeURIComponent(data.project.key)}`);
</script>

<PageHeader title={data.project.name} description="Pages in this project's space.">
	{#snippet actions()}
		<Button href="/projects/{data.project.key}">Open project</Button>
		<Button href={newHref} variant="primary">New page</Button>
	{/snippet}
</PageHeader>

<ScopeNav projects={data.projects} currentKey={data.project.key} />
{#if data.project.status === 'archived'}
	<p class="archived">
		<Badge tone="warning">Archived</Badge> This project is archived; its pages stay editable.
	</p>
{/if}
<Banner tone="success" message={data.notice} />

{#if data.tree.nodes.length === 0}
	<EmptyState
		title="No pages here yet — create one"
		description="Specs, runbooks and decisions for this project."
		action={{ href: newHref, label: 'New page' }}
	/>
{:else}
	<ScopeTreeView tree={data.tree} label="{data.project.name} pages" />
{/if}

<style>
	.archived {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 0 0 14px;
		color: var(--muted);
		font-size: 14px;
	}
</style>
