<!-- Due: a due date, red with an "Overdue" label when the task is open and the date is before the team's today. -->
<script lang="ts">
	import type { TaskStatus } from '#lib/shared/enums';
	import { formatDue, isOverdue } from './options';

	let {
		dueOn,
		status,
		today,
		empty = '—'
	}: { dueOn: string | null; status: TaskStatus; today: string; empty?: string } = $props();
	const overdue = $derived(isOverdue({ dueOn, status }, today));
</script>

{#if dueOn}
	<time datetime={dueOn} class="due" class:overdue
		>{formatDue(dueOn, today)}{#if overdue}<span class="sr-only">, overdue</span>{/if}</time
	>
{:else}
	<span class="none">{empty}</span>
{/if}

<style>
	.due {
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.overdue {
		color: var(--danger);
		font-weight: 600;
	}
	.none {
		color: var(--subtle);
		font-size: 13px;
	}
</style>
