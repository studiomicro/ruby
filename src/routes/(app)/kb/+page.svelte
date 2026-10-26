<script lang="ts">
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import ScopeTreeView from './ScopeTreeView.svelte';
	import ScopeNav from './ScopeNav.svelte';

	let { data } = $props();
</script>

<PageHeader
	title="Knowledge base"
	description="Team-wide pages. Project pages live in each project's space."
>
	{#snippet actions()}
		<Button href="/kb/new" variant="primary">New page</Button>
	{/snippet}
</PageHeader>

<ScopeNav projects={data.projects} />
<Banner tone="success" message={data.notice} />

{#if data.tree.nodes.length === 0}
	<EmptyState
		title="No pages yet"
		description="Write down what the team knows: how-tos, decisions, onboarding."
		action={{ href: '/kb/new', label: 'Create the first page' }}
	/>
{:else}
	<ScopeTreeView tree={data.tree} label="Team pages" />
{/if}
