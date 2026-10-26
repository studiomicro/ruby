<!--
	UpdateBanner: shown when SvelteKit detects a newer deployed version (`updated.current`, polled by
	kit.version.pollInterval). Reload reloads at once, or asks first when a form on the page holds unsaved input (an
	in-app dialog, not window.confirm). After an update the next client-side navigation becomes a full page load, so
	an old client never runs against a new server. Sits above the phone tab bar and respects the --sai-* insets.
-->
<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import { updated } from '$app/state';
	import Button from '#lib/ui/kit/Button.svelte';
	import { hasDirtyForm } from './dirty-forms';

	let dialog = $state<HTMLDialogElement>();
	/** Where "Reload anyway" goes: the page itself, or the link a user followed with unsaved input. */
	let target = $state<string | null>(null);

	beforeNavigate(({ willUnload, to, cancel }) => {
		if (!updated.current || willUnload || !to?.url) return;
		cancel();
		if (hasDirtyForm()) confirmLeave(to.url.href);
		else location.href = to.url.href;
	});

	function confirmLeave(href: string | null) {
		target = href;
		dialog?.showModal();
	}

	function reload() {
		if (hasDirtyForm()) confirmLeave(null);
		else location.reload();
	}

	function leave() {
		if (target) location.href = target;
		else location.reload();
	}
</script>

{#if updated.current}
	<div class="update" role="status">
		<p>A new version of Ruby is available.</p>
		<div class="actions">
			<Button type="button" variant="primary" onclick={reload}>Reload</Button>
			<a class="link" href="/releases">What's new</a>
		</div>
	</div>
{/if}

<dialog bind:this={dialog} class="confirm" aria-labelledby="update-confirm-title">
	<h2 id="update-confirm-title">Reload and lose your changes?</h2>
	<p>You have typed something that is not saved yet. Reloading discards it.</p>
	<div class="actions">
		<Button type="button" variant="danger" onclick={leave}>Reload anyway</Button>
		<Button type="button" variant="secondary" onclick={() => dialog?.close()}>Keep editing</Button>
	</div>
</dialog>

<style>
	.update {
		position: fixed;
		/* Below the tab bar's stacking context (30), so the More sheet opened from it covers the banner. */
		z-index: 25;
		left: max(8px, var(--sai-left));
		right: max(8px, var(--sai-right));
		bottom: calc(var(--tabbar-h) + var(--sai-bottom) + 8px);
		box-sizing: border-box;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 16px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
		box-shadow: var(--shadow-2);
		font-size: 14px;
	}
	p {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 8px;
		color: var(--accent);
	}
	.confirm {
		box-sizing: border-box;
		width: min(420px, calc(100vw - 32px));
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
		color: var(--fg);
		box-shadow: var(--shadow-2);
	}
	.confirm h2 {
		margin: 0 0 8px;
		font-size: 17px;
	}
	.confirm p {
		margin-bottom: 16px;
	}
	@media (min-width: 768px) {
		.update {
			left: auto;
			right: max(16px, var(--sai-right));
			bottom: calc(16px + var(--sai-bottom));
			max-width: 420px;
		}
	}
</style>
