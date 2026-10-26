<script lang="ts">
	import Avatar from '#lib/ui/kit/Avatar.svelte';

	let {
		id,
		name,
		compact = false
	}: { id: string | null; name: string | null; compact?: boolean } = $props();
</script>

{#if id}
	<span class="assignee" title={compact ? (name ?? undefined) : undefined}>
		<Avatar name={name ?? '?'} seed={id} size="sm" />
		<span class:sr-only={compact} class="name">{name}</span>
	</span>
{:else}
	<span class="nobody" class:sr-only={compact}>Unassigned</span>
{/if}

<style>
	.assignee {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-size: 13px;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nobody {
		color: var(--subtle);
		font-size: 13px;
	}
</style>
