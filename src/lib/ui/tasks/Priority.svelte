<!-- Priority: a dot (colour by level, decorative) plus the label; `compact` shows the dot with a screen-reader label. -->
<script lang="ts">
	import { TASK_PRIORITY_LABELS, type TaskPriority } from '#lib/shared/enums';

	let { priority, compact = false }: { priority: TaskPriority; compact?: boolean } = $props();
</script>

<span class="priority {priority}" title={compact ? TASK_PRIORITY_LABELS[priority] : undefined}>
	<span class="dot" aria-hidden="true"></span>
	<span class:sr-only={compact}>{TASK_PRIORITY_LABELS[priority]}</span>
</span>

<style>
	.priority {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--border-strong);
		flex: none;
	}
	.low .dot {
		background: var(--subtle);
	}
	.medium .dot {
		background: var(--warning);
	}
	.high .dot {
		background: var(--accent);
	}
	.urgent .dot {
		background: var(--danger);
		box-shadow: 0 0 0 2px var(--danger-soft);
	}
	.urgent {
		color: var(--danger);
		font-weight: 500;
	}
</style>
