<!--
	InstallSteps (RB-20): the iOS "Add to Home Screen" steps, opened only from an "Install Ruby" row (InstallEntry).
	iOS has no install event, so these are plain steps with Safari's share glyph drawn inline (no remote image). In an
	app's built-in browser it says to open the page in Safari, with a Copy link button. One instance in the app layout.
-->
<script lang="ts">
	import Button from '#lib/ui/kit/Button.svelte';
	import Dialog from '#lib/ui/kit/Dialog.svelte';
	import Icon from '#lib/ui/kit/Icon.svelte';
	import { currentRow, install } from './install.svelte';

	const inSafari = $derived(currentRow() === 'ios-steps');
	let copied = $state<'idle' | 'done' | 'failed'>('idle');

	async function copyLink() {
		try {
			await navigator.clipboard.writeText(location.href);
			copied = 'done';
		} catch {
			copied = 'failed';
		}
	}
</script>

<Dialog
	bind:open={install.stepsOpen}
	title="Install Ruby"
	size="sm"
	onclose={() => (copied = 'idle')}
>
	{#if !inSafari}
		<p class="lead">Open this page in Safari to install Ruby.</p>
		<p class="help">
			Copy the link, open Safari, paste it in the address bar, then follow these steps:
		</p>
	{/if}
	<ol class="steps">
		<li>
			Tap the Share button <span class="glyph"><Icon name="share" size={18} /></span> in Safari's toolbar.
		</li>
		<li>Scroll and tap "Add to Home Screen".</li>
		<li>Tap "Add".</li>
	</ol>
	{#snippet actions()}
		{#if !inSafari}
			<Button type="button" onclick={copyLink}>Copy link</Button>
			<p class="copy-state" role="status">
				{copied === 'done' ? 'Link copied.' : copied === 'failed' ? 'Could not copy the link.' : ''}
			</p>
		{/if}
		<Button type="button" variant="primary" onclick={() => (install.stepsOpen = false)}>Done</Button
		>
	{/snippet}
</Dialog>

<style>
	.lead {
		margin: 0;
		font-weight: 500;
	}
	.help {
		margin: 0;
		color: var(--muted);
	}
	.steps {
		display: grid;
		gap: 8px;
		margin: 0;
		padding-left: 20px;
	}
	.glyph {
		display: inline-grid;
		place-items: center;
		vertical-align: -4px;
		color: var(--accent);
	}
	.copy-state {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
</style>
