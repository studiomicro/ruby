<script lang="ts">
	import { page } from '$app/state';

	let { data, children } = $props();
	const tabs = $derived([
		{ href: '/time-off', label: 'My time off' },
		{ href: '/time-off/calendar', label: 'Calendar' },
		...(data.tabs.approvals ? [{ href: '/time-off/approvals', label: 'Approvals' }] : []),
		...(data.tabs.team ? [{ href: '/time-off/team', label: 'Team' }] : []),
		...(data.tabs.settings ? [{ href: '/time-off/settings', label: 'Settings' }] : [])
	]);
</script>

<nav class="tabs" aria-label="Time off">
	{#each tabs as tab (tab.href)}
		<a href={tab.href} aria-current={page.url.pathname === tab.href ? 'page' : undefined}
			>{tab.label}
			{#if tab.href === '/time-off/approvals' && page.data.pendingApprovals > 0}
				<span class="count" aria-label="{page.data.pendingApprovals} to decide"
					>{page.data.pendingApprovals}</span
				>
			{/if}
		</a>
	{/each}
</nav>

{@render children()}

<style>
	.tabs {
		display: flex;
		gap: 4px;
		margin: 0 0 18px;
		padding-bottom: 2px;
		overflow-x: auto;
		border-bottom: 1px solid var(--border);
		scrollbar-width: thin;
	}
	.tabs a {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: none;
		min-height: 36px;
		padding: 0 12px;
		border-bottom: 2px solid transparent;
		color: var(--muted);
		font-size: 14px;
		font-weight: 500;
		text-decoration: none;
		white-space: nowrap;
	}
	@media (pointer: coarse) {
		.tabs a {
			min-height: 44px;
		}
	}
	.tabs a:hover {
		color: var(--fg);
	}
	.tabs a[aria-current='page'] {
		border-bottom-color: var(--accent);
		color: var(--fg);
	}
	.count {
		min-width: 18px;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-fg);
		font-size: 11px;
		font-weight: 600;
		line-height: 18px;
		text-align: center;
	}
</style>
