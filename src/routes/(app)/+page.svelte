<script lang="ts">
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';

	let { data } = $props();
	const firstName = $derived(data.user.name.split(/\s+/)[0] || data.user.name);
</script>

<PageHeader
	title="Welcome, {firstName}"
	description="Your team's projects and knowledge in one place."
/>

<div class="cards">
	<section aria-labelledby="home-projects">
		<h2 id="home-projects">Projects</h2>
		<EmptyState
			title="Plan the work"
			description="Projects hold numbered tasks you can see as a list or a board."
			action={{ href: '/projects', label: 'Open projects' }}
		/>
	</section>
	<section aria-labelledby="home-kb">
		<h2 id="home-kb">Knowledge base</h2>
		<EmptyState
			title="Write it down"
			description="Markdown pages for what the team knows, with revisions and search."
			action={{ href: '/kb', label: 'Open the knowledge base' }}
		/>
	</section>
</div>

<style>
	.cards {
		display: grid;
		gap: 20px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
	}
	h2 {
		margin: 0 0 10px;
		font-size: 14px;
		font-weight: 600;
		color: var(--muted);
	}
</style>
