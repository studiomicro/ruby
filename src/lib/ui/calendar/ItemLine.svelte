<!--
	ItemLine: one calendar item as a list row (agenda, week lists): kind icon and label, time ("All day" or
	"14:00–15:30 WIB" on its first day), title, and Private / Overdue / Done labels. The whole row is the link (at
	least 44 px tall); an item without a link is plain text.
-->
<script lang="ts">
	import type { CalendarItem } from '#lib/shared/calendar-items';
	import Icon from '#lib/ui/kit/Icon.svelte';
	import { KIND_ICON, KIND_LABEL } from './kinds';
	import { timeRange } from './when';

	let {
		item,
		day,
		zone,
		zoneLabel
	}: { item: CalendarItem; day: string; zone: string; zoneLabel: string } = $props();

	const time = $derived(
		item.allDay || item.startAt === null || item.endAt === null
			? 'All day'
			: day === item.startOn
				? `${timeRange(item.startAt, item.endAt, zone)} ${zoneLabel}`
				: 'Continues'
	);
</script>

<svelte:element
	this={item.href ? 'a' : 'div'}
	href={item.href ?? undefined}
	class="line kind-{item.kind}"
	class:done={item.done}
>
	<span class="icon"><Icon name={KIND_ICON[item.kind]} size={16} /></span>
	<span class="body">
		<span class="title"><span class="sr-only">{KIND_LABEL[item.kind]}: </span>{item.title}</span>
		<span class="meta">
			<span>{time}</span>
			{#if item.private}<span class="tag">Private</span>{/if}
			{#if item.overdue}<span class="tag danger">Overdue</span>{/if}
			{#if item.done}<span class="tag">Done</span>{/if}
		</span>
	</span>
</svelte:element>

<style>
	.line {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		min-height: 44px;
		padding: 6px 8px;
		box-sizing: border-box;
		border-radius: var(--radius-m);
		color: var(--fg);
		text-decoration: none;
		min-width: 0;
	}
	a.line:hover {
		background: var(--surface-2);
	}
	a.line:focus-visible {
		outline: 2px solid var(--ring);
	}
	.icon {
		display: inline-flex;
		flex: none;
		padding-top: 2px;
		color: var(--muted);
	}
	.kind-event .icon {
		color: var(--accent);
	}
	.kind-timeoff .icon {
		color: var(--warning);
	}
	.body {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.title {
		font-size: var(--text-base);
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.done .title {
		text-decoration: line-through;
		color: var(--muted);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 8px;
		color: var(--muted);
		font-size: var(--text-xs);
	}
	.tag {
		padding: 0 6px;
		border-radius: 999px;
		background: var(--surface-2);
	}
	.tag.danger {
		background: var(--danger-soft);
		color: var(--danger);
	}
</style>
