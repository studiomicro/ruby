<!-- NewDot: a small "New" marker for the What's new link while the newest release is unread. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshUnseen, releaseDot } from './release-seen.svelte';

	onMount(refreshUnseen);
</script>

{#if releaseDot.unseen}<span class="new-dot" role="img" aria-label="New"></span>{/if}

<style>
	.new-dot {
		margin-left: auto;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
	}
</style>
