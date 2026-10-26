<!--
	TypeBadge: a task's type (RB-12) as a fixed icon plus its name, never colour alone. `quiet` renders nothing for the
	default type `task` (board cards and the list stay calm).
-->
<script lang="ts">
	import { TASK_TYPE_LABELS, type TaskType } from '#lib/shared/enums';
	import Icon, { type IconName } from '#lib/ui/kit/Icon.svelte';

	let { type, quiet = false }: { type: TaskType; quiet?: boolean } = $props();

	const ICON: Record<TaskType, IconName> = {
		task: 'task',
		bug: 'bug',
		feature_request: 'idea',
		improvement: 'improve'
	};
</script>

{#if !(quiet && type === 'task')}
	<span class="type {type}"><Icon name={ICON[type]} size={14} />{TASK_TYPE_LABELS[type]}</span>
{/if}

<style>
	.type {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 20px;
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: 500;
		white-space: nowrap;
	}
	.bug {
		color: var(--danger);
	}
	.feature_request,
	.improvement {
		color: var(--accent);
	}
</style>
