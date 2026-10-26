<!--
	RefreshAction (RB-20): reloads the page's data without losing what was typed (`invalidateAll`, no page reload). An
	installed app has no reload button and pull-to-refresh is off in standalone (app.css), so this is the visible way to
	refresh. In the phone More sheet (`variant="sheet"`) and Account's "App" section (`variant="account"`). Shows its
	saving state and the result; offline it says so and sends nothing.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import Button from '#lib/ui/kit/Button.svelte';
	import Icon from '#lib/ui/kit/Icon.svelte';
	import { rememberTypedInput } from './keep-input';

	let { variant }: { variant: 'sheet' | 'account' } = $props();
	const uid = $props.id();

	let status = $state<'idle' | 'saving' | 'done' | 'offline' | 'failed'>('idle');
	const MESSAGES = {
		idle: '',
		saving: 'Refreshing…',
		done: 'Updated just now.',
		offline: 'You are offline. Try again when you are back online.',
		failed: 'Could not refresh. Try again.'
	} as const;

	async function refresh() {
		if (status === 'saving') return;
		if (!navigator.onLine) {
			status = 'offline';
			return;
		}
		status = 'saving';
		const restore = rememberTypedInput();
		try {
			await invalidateAll();
			await tick();
			restore();
			status = 'done';
		} catch {
			status = 'failed';
		}
	}
</script>

{#if variant === 'sheet'}
	<li>
		<button
			type="button"
			class="sheet-row"
			onclick={refresh}
			disabled={status === 'saving'}
			aria-describedby="{uid}-status"
		>
			<Icon name="refresh" />Refresh
		</button>
		<p
			id="{uid}-status"
			class="status"
			class:bad={status === 'offline' || status === 'failed'}
			role="status"
		>
			{MESSAGES[status]}
		</p>
	</li>
{:else}
	<div class="refresh">
		<div class="text">
			<p class="name">Refresh</p>
			<p class="help">Load the latest data without losing what you typed.</p>
			<p class="status" class:bad={status === 'offline' || status === 'failed'} role="status">
				{MESSAGES[status]}
			</p>
		</div>
		<Button
			type="button"
			onclick={refresh}
			loading={status === 'saving'}
			loadingLabel="Refreshing…"
		>
			<Icon name="refresh" />Refresh
		</Button>
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
	.sheet-row:disabled {
		cursor: progress;
		color: var(--muted);
	}
	.status {
		margin: 0;
		padding: 0 12px;
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.status:empty {
		display: none;
	}
	.status.bad {
		color: var(--danger);
	}
	.refresh {
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
	.refresh .status {
		padding: 0;
		margin-top: 4px;
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
