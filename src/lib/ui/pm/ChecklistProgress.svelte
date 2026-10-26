<!-- ChecklistProgress: "3/7" steps done, with the full sentence for screen readers. Nothing without steps. -->
<script lang="ts">
	let { progress }: { progress: { done: number; total: number } | null } = $props();
</script>

{#if progress && progress.total > 0}
	<span class="progress" class:complete={progress.done === progress.total}
		><span aria-hidden="true">☑ {progress.done}/{progress.total}</span><span class="sr-only"
			>{progress.done} of {progress.total} steps done</span
		></span
	>
{/if}

<style>
	.progress {
		display: inline-flex;
		align-items: center;
		min-height: 20px;
		color: var(--muted);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.complete {
		color: var(--success);
	}
</style>
