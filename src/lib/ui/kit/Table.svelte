<!--
	Table: a data table in a bordered box that scrolls sideways inside itself, never the page (Kumo Table). Pass the
	<thead> and <tbody> as children, with <th scope="col"> headers. `caption` names the table (read by screen readers;
	shown when `showCaption`) and labels the scroll region, which keyboard users can focus to scroll. `compact` uses
	Kumo's dense header (12 px on a tint). Give numeric cells `class="num"` to right-align them in tabular figures.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		caption,
		showCaption = false,
		compact = false,
		children
	}: {
		caption: string;
		showCaption?: boolean;
		compact?: boolean;
		children: Snippet;
	} = $props();
</script>

<!-- A scrollable region must be focusable so keyboard users can scroll it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="table-wrap" role="region" aria-label={caption} tabindex="0">
	<table class:compact>
		<caption class:sr-only={!showCaption}>{caption}</caption>
		{@render children()}
	</table>
</div>

<style>
	.table-wrap {
		max-width: 100%;
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-base);
	}
	caption {
		padding: 12px 12px 4px;
		color: var(--muted);
		font-size: var(--text-sm);
		text-align: left;
	}
	table :global(th) {
		padding: 10px 12px;
		border-bottom: 1px solid var(--surface-3);
		color: var(--fg);
		font-weight: 600;
		text-align: left;
		white-space: nowrap;
	}
	table :global(td) {
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
		vertical-align: middle;
	}
	table :global(tbody tr:last-child td) {
		border-bottom: 0;
	}
	table :global(tbody tr:hover) {
		background: var(--elevated);
	}
	table :global(.num) {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.compact :global(th) {
		padding: 8px 12px;
		background: var(--elevated);
		color: var(--fg-strong);
		font-size: var(--text-xs);
	}
	.compact :global(td) {
		padding: 8px 12px;
	}
</style>
