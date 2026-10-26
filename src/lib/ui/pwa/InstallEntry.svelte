<!--
	InstallEntry (RB-20): the passive "Install Ruby" row, in the phone More sheet (`variant="sheet"`, a list row) and in
	Account's "App" section (`variant="account"`). Chromium: the button opens the browser's own install dialog, only on
	a tap. iOS: the button opens the "Add to Home Screen" steps (InstallSteps.svelte). Never a banner, toast or modal
	on load. The install path is known in the browser only: the sheet row appears once there is something to tap, the
	account row is rendered on the server with neutral text and gets its button after hydration.
-->
<script lang="ts">
	import Button from '#lib/ui/kit/Button.svelte';
	import Icon from '#lib/ui/kit/Icon.svelte';
	import { currentRow, install, promptInstall } from './install.svelte';

	let { variant }: { variant: 'sheet' | 'account' } = $props();

	const row = $derived(currentRow());
	const actionable = $derived(
		row === 'prompt' || row === 'ios-steps' || row === 'ios-open-in-safari'
	);

	function open() {
		if (row === 'prompt') void promptInstall();
		else install.stepsOpen = true;
	}
</script>

{#if variant === 'sheet'}
	{#if actionable}
		<li>
			<button type="button" class="sheet-row" onclick={open}>
				<Icon name="download" />Install Ruby
			</button>
		</li>
	{/if}
{:else}
	<!-- Rendered on the server too (as "not known yet"), so the section does not grow after hydration. -->
	<div class="install">
		<div class="text">
			<p class="name">Install Ruby</p>
			{#if row === null}
				<p class="help">Add Ruby to your home screen and open it like an app.</p>
			{:else if row === 'installed'}
				<p class="help">Ruby is installed on this device.</p>
			{:else if row === 'prompt'}
				<p class="help">Add Ruby to your home screen and open it like an app.</p>
			{:else if row === 'ios-steps'}
				<p class="help">Add Ruby to your home screen from Safari's Share menu.</p>
			{:else if row === 'ios-open-in-safari'}
				<p class="help">Open this page in Safari to install Ruby.</p>
			{:else if row === 'dismissed'}
				<p class="help">
					You chose not to install Ruby for now. You can still install it from your browser's menu.
				</p>
			{:else}
				<p class="help">
					This browser offers no install button here. In Chrome or Edge, use the browser menu to
					install Ruby; on iPhone, use Safari.
				</p>
			{/if}
		</div>
		{#if actionable}
			<Button type="button" onclick={open}>
				<Icon name="download" />{row === 'prompt' ? 'Install' : 'Show how'}
			</Button>
		{/if}
	</div>
{/if}

<style>
	.sheet-row {
		display: flex;
		align-items: center;
		gap: 12px;
		box-sizing: border-box;
		width: 100%;
		min-height: 48px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-m);
		background: none;
		color: var(--fg);
		font: inherit;
		font-size: 15px;
		text-align: left;
		cursor: pointer;
	}
	.sheet-row :global(svg) {
		color: var(--muted);
	}
	.sheet-row:hover {
		background: var(--surface-2);
	}
	.install {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 16px;
	}
	.text {
		min-width: 0;
		flex: 1 1 220px;
	}
	.name {
		margin: 0;
		font-weight: 500;
	}
	.help {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
</style>
