<!--
	ScopeNav: the knowledge base's spaces — the team-wide pages and each active project's pages. The links wrap on a
	phone instead of scrolling the page sideways.
-->
<script lang="ts">
	let {
		projects,
		currentKey = null
	}: {
		projects: { id: string; key: string; name: string }[];
		/** The project shown, or null for the team-wide pages. */
		currentKey?: string | null;
	} = $props();
</script>

<nav class="scopes" aria-label="Spaces">
	<ul>
		<li>
			<a href="/kb" aria-current={currentKey === null ? 'page' : undefined}>Team</a>
		</li>
		{#each projects as project (project.id)}
			<li>
				<a
					href="/kb/projects/{project.key}"
					aria-current={currentKey === project.key ? 'page' : undefined}
					>{project.name} <span class="key">{project.key}</span></a
				>
			</li>
		{/each}
	</ul>
</nav>

<style>
	ul {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0 0 18px;
		padding: 0;
		list-style: none;
	}
	a {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		min-height: 32px;
		padding: 0 12px;
		box-sizing: border-box;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		color: var(--fg);
		font-size: 14px;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	a:hover {
		background: var(--surface-2);
	}
	a[aria-current='page'] {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}
	.key {
		color: var(--muted);
		font-size: 12px;
	}
	@media (pointer: coarse) {
		a {
			min-height: 44px;
		}
	}
</style>
