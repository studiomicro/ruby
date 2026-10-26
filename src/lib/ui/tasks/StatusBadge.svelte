<script lang="ts">
	import { TASK_STATUS_LABELS, type TaskStatus } from '#lib/shared/enums';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import { statusTone } from './options';

	let { status }: { status: TaskStatus } = $props();
</script>

<Badge tone={statusTone(status)}>{TASK_STATUS_LABELS[status]}</Badge>
