<!--
	OfflineBanner (RB-20): a slim, non-blocking notice while the device is offline (online.svelte.ts). It sits in the
	app layout's banner stack under the update banner, above the phone tab bar, inside the --sai-* insets, and hides
	when the connection is back. Nothing is queued while offline, so it says nothing can be saved.
-->
<script lang="ts">
	import { leave, riseOrFade } from '#lib/ui/motion';
	import { connection } from './online.svelte';
</script>

<div class="offline-banner" role="status">
	{#if !connection.online}<p in:riseOrFade|local out:leave|local>
			You are offline. Changes can't be saved.
		</p>{/if}
</div>

<style>
	/* The live region stays in place (empty while online) so the change is announced; only the notice is drawn. */
	.offline-banner p {
		box-sizing: border-box;
		margin: 0;
		padding: 8px 12px;
		border: 1px solid color-mix(in srgb, var(--warning) 22%, transparent);
		border-radius: var(--radius-l);
		background: var(--warning-soft);
		box-shadow: var(--shadow-2);
		color: var(--warning);
		font-size: 14px;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
</style>
