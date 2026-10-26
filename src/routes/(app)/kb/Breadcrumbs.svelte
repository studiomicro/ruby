<!--
	Breadcrumbs: Knowledge base (or Knowledge base / <project>), then each ancestor of the page. Wraps on a phone.
-->
<script lang="ts">
	let {
		project,
		ancestors,
		current
	}: {
		project: { key: string; name: string } | null;
		ancestors: { id: string; title: string }[];
		/** A last, unlinked crumb (an editor or history view names the page here). */
		current?: { id: string; title: string };
	} = $props();
</script>

<nav class="crumbs" aria-label="Breadcrumb">
	<ol>
		<li><a href="/kb">Knowledge base</a></li>
		{#if project}
			<li><a href="/kb/projects/{project.key}">{project.name}</a></li>
		{/if}
		{#each ancestors as crumb (crumb.id)}
			<li><a href="/kb/{crumb.id}">{crumb.title}</a></li>
		{/each}
		{#if current}
			<li><a href="/kb/{current.id}">{current.title}</a></li>
		{/if}
	</ol>
</nav>

<style>
	ol {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px 6px;
		margin: 0 0 12px;
		padding: 0;
		list-style: none;
		font-size: 13px;
	}
	li {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	li + li::before {
		content: '/';
		color: var(--subtle);
	}
	a {
		color: var(--muted);
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	a:hover {
		color: var(--fg);
		text-decoration: underline;
	}
	@media (pointer: coarse) {
		a {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}
	}
</style>
