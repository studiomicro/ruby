<!--
	Tabs: a row of tabs in Kumo's two looks, `underline` (sections of a page) or `segmented` (switching a view).
	When every item has an `href`, it is a <nav> of links named by `label`, with aria-current="page" on `value`: it
	works without JavaScript and suits a route per tab. Otherwise it is a WAI-ARIA tablist: `value` is bindable, the
	arrow keys, Home and End move between tabs (automatic activation), and `panel` renders the selected tab's content
	in a tabpanel labelled by its tab. Without JavaScript a tablist shows its first (or given) tab only.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface TabItem {
		id: string;
		label: string;
		href?: string;
	}

	const uid = $props.id();
	let {
		items,
		value = $bindable(''),
		label,
		variant = 'underline',
		panel
	}: {
		items: readonly TabItem[];
		value?: string;
		/** Accessible name of the tab row. */
		label: string;
		variant?: 'underline' | 'segmented';
		panel?: Snippet<[string]>;
	} = $props();

	const links = $derived(items.length > 0 && items.every((item) => item.href));
	const selected = $derived(items.some((item) => item.id === value) ? value : (items[0]?.id ?? ''));
	const tabId = (id: string) => `${uid}-tab-${id}`;
	const panelId = $derived(`${uid}-panel`);

	let list = $state<HTMLElement>();
	function onkeydown(event: KeyboardEvent) {
		const index = items.findIndex((item) => item.id === selected);
		let next = -1;
		if (event.key === 'ArrowRight') next = (index + 1) % items.length;
		else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = items.length - 1;
		if (next < 0) return;
		const target = items[next];
		if (!target) return;
		event.preventDefault();
		value = target.id;
		list?.querySelector<HTMLElement>(`#${CSS.escape(tabId(target.id))}`)?.focus();
	}
</script>

{#if links}
	<nav class="tabs {variant}" aria-label={label}>
		{#each items as item (item.id)}
			<a href={item.href} class="tab" aria-current={item.id === value ? 'page' : undefined}
				>{item.label}</a
			>
		{/each}
	</nav>
{:else}
	<div
		class="tabs {variant}"
		role="tablist"
		aria-label={label}
		tabindex="-1"
		bind:this={list}
		{onkeydown}
	>
		{#each items as item (item.id)}
			<button
				type="button"
				role="tab"
				id={tabId(item.id)}
				class="tab"
				aria-selected={item.id === selected}
				aria-controls={panel ? panelId : undefined}
				tabindex={item.id === selected ? 0 : -1}
				onclick={() => (value = item.id)}>{item.label}</button
			>
		{/each}
	</div>
	{#if panel}
		<div class="panel" role="tabpanel" id={panelId} aria-labelledby={tabId(selected)} tabindex="0">
			{@render panel(selected)}
		</div>
	{/if}
{/if}

<style>
	.tabs {
		display: flex;
		max-width: 100%;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.tabs::-webkit-scrollbar {
		display: none;
	}
	.tab {
		display: inline-flex;
		align-items: center;
		flex: none;
		box-sizing: border-box;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: var(--text-base);
		font-weight: 500;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
		transition:
			color var(--dur-fast) var(--ease),
			background-color var(--dur-fast) var(--ease);
	}
	.tab:hover {
		color: var(--fg);
	}
	.tab:focus-visible {
		outline-offset: -2px;
	}

	/* Kumo underline tabs: a hairline under the row, a 2 px blue bar under the current tab. */
	.underline {
		gap: 4px;
		border-bottom: 1px solid var(--border);
	}
	.underline .tab {
		min-height: 40px;
		padding: 0 10px;
		margin-bottom: -1px;
		border-bottom: 2px solid transparent;
	}
	.underline .tab:is([aria-current='page'], [aria-selected='true']) {
		border-bottom-color: var(--brand);
		color: var(--fg);
	}

	/* Kumo segmented tabs: a recessed track, the current tab a raised pill. */
	.segmented {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border-radius: var(--radius-m);
		background: var(--surface-2);
	}
	.segmented .tab {
		min-height: 30px;
		padding: 0 12px;
		border-radius: var(--radius-s);
		font-size: var(--text-sm);
	}
	.segmented .tab:is([aria-current='page'], [aria-selected='true']) {
		background: var(--surface);
		box-shadow:
			0 0 0 1px var(--border),
			var(--shadow-1);
		color: var(--fg);
	}
	@media (pointer: coarse) {
		.underline .tab,
		.segmented .tab {
			min-height: 44px;
		}
	}
	.panel {
		padding-top: 16px;
	}
	.panel:focus-visible {
		outline-offset: 4px;
	}
</style>
