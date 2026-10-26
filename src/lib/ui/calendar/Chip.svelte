<!--
	Chip: one item inside a month or week cell: kind icon, start time for timed items, the title cut with an
	ellipsis (the full title is the tooltip and the accessible name).
-->
<script lang="ts">
	import { utcToZoned } from '#lib/shared/calendar';
	import type { CalendarItem } from '#lib/shared/calendar-items';
	import Icon from '#lib/ui/kit/Icon.svelte';
	import { KIND_ICON, KIND_LABEL } from './kinds';

	let { item, day, zone }: { item: CalendarItem; day: string; zone: string } = $props();
	const time = $derived(
		!item.allDay && item.startAt !== null && day === item.startOn
			? utcToZoned(item.startAt, zone).time
			: null
	);
</script>

<svelte:element
	this={item.href ? 'a' : 'span'}
	href={item.href ?? undefined}
	class="chip kind-{item.kind}"
	class:done={item.done}
	class:overdue={item.overdue}
	title={item.title}
>
	<Icon name={KIND_ICON[item.kind]} size={12} />
	<span class="text"
		><span class="sr-only"
			>{KIND_LABEL[item.kind]}{item.private ? ', private' : ''}{item.overdue ? ', overdue' : ''}:
		</span>{#if time}<span class="time">{time}</span>
		{/if}{item.title}</span
	>
</svelte:element>

<style>
	.chip {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		min-height: 22px;
		padding: 0 6px;
		border-radius: var(--radius-s);
		background: var(--surface-2);
		color: var(--fg);
		font-size: var(--text-xs);
		line-height: 1.3;
		text-decoration: none;
	}
	@media (pointer: coarse) {
		.chip {
			min-height: 44px;
		}
	}
	a.chip:hover {
		background: var(--surface-3);
	}
	.kind-event {
		background: var(--accent-soft);
	}
	.kind-timeoff {
		background: var(--warning-soft);
	}
	.overdue {
		box-shadow: inset 2px 0 0 var(--danger);
	}
	.done .text {
		text-decoration: line-through;
		color: var(--muted);
	}
	.text {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.time {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
</style>
