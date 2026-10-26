<!--
	Button: the one button (and button-styled link), in Kumo's look. `variant` primary (blue fill, one per view),
	secondary (bordered), ghost (text only) or danger (bordered, red text). `loading` disables it and shows a spinner plus `loadingLabel`, for a form
	that is being sent (`use:enhance` sets it). `href` renders a link with the same look. `name`/`value` and
	`formaction` work as on <button> (several actions in one form).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		variant = 'secondary',
		size = 'md',
		type = 'button',
		disabled = false,
		loading = false,
		loadingLabel,
		saved = false,
		full = false,
		href,
		formaction,
		name,
		value,
		label,
		onclick,
		children
	}: {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'sm' | 'md';
		type?: 'button' | 'submit';
		disabled?: boolean;
		/** The form is being sent: the button is disabled and shows `loadingLabel` (default: its own label). */
		loading?: boolean;
		loadingLabel?: string;
		/** RB-20 Part B: the server confirmed the save; shows "Saved" with a tick (the page clears it after a moment). */
		saved?: boolean;
		full?: boolean;
		/** Renders a link styled as a button. */
		href?: string;
		formaction?: string;
		name?: string;
		value?: string;
		/** Accessible name when the visible content is only an icon. */
		label?: string;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	} = $props();
</script>

{#if href}
	<a {href} {onclick} aria-label={label} class="btn {variant} {size}" class:full>
		{@render children()}
	</a>
{:else}
	<button
		{type}
		{formaction}
		{name}
		{value}
		{onclick}
		disabled={disabled || loading}
		aria-busy={loading || undefined}
		aria-label={label}
		class="btn {variant} {size}"
		class:full
	>
		{#if loading}
			<span class="spinner" aria-hidden="true"></span>
			{#if loadingLabel}{loadingLabel}{:else}{@render children()}{/if}
		{:else if saved}
			<span class="tick" aria-hidden="true"></span>Saved
		{:else}
			{@render children()}
		{/if}
	</button>
{/if}

<style>
	/* Kumo Button: 36 px (base) or 28 px (sm), 1 px line border, xs shadow, 100 ms state changes. */
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		box-sizing: border-box;
		border: 1px solid transparent;
		border-radius: var(--radius-m);
		box-shadow: var(--shadow-1);
		font: inherit;
		font-weight: 500;
		line-height: 1;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color var(--dur-fast) var(--ease),
			border-color var(--dur-fast) var(--ease),
			color var(--dur-fast) var(--ease);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.md {
		min-height: 36px;
		padding: 0 12px;
		font-size: var(--text-base);
	}
	.sm {
		gap: 4px;
		min-height: 28px;
		padding: 0 8px;
		border-radius: var(--radius-s);
		font-size: var(--text-sm);
	}
	/* Touch: at least a 44 px target. */
	@media (pointer: coarse) {
		.md,
		.sm {
			min-height: 44px;
		}
	}
	.full {
		width: 100%;
	}
	/* Kumo's emphasis button: a darker 1 px edge and a light top highlight on the blue fill. */
	.primary {
		border-color: color-mix(in srgb, var(--brand), black 12%);
		background: var(--brand);
		box-shadow:
			inset 0 1px 0 color-mix(in srgb, var(--brand), white 25%),
			var(--shadow-1);
		color: var(--brand-fg);
	}
	.primary:hover:not(:disabled) {
		background: var(--brand-hover);
	}
	.secondary {
		border-color: var(--border);
		background: var(--surface);
		color: var(--fg);
	}
	.secondary:hover:not(:disabled) {
		background: var(--surface-2);
	}
	.ghost {
		background: transparent;
		box-shadow: none;
		color: var(--fg);
	}
	.ghost:hover:not(:disabled) {
		background: var(--surface-2);
	}
	.danger {
		border-color: var(--border);
		background: var(--surface);
		color: var(--danger);
	}
	.danger:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
		background: var(--danger-soft);
	}
	.spinner {
		width: 12px;
		height: 12px;
		border: 2px solid currentColor;
		border-right-color: transparent;
		border-radius: 50%;
		animation: spin var(--dur-loop) linear infinite;
	}
	/* RB-20 Part B: the saved tick scales in from 0.8 (`--dur-fast`); under reduced motion it is simply there. */
	.tick {
		width: 10px;
		height: 6px;
		margin: -3px 1px 0;
		border-bottom: 2px solid currentColor;
		border-left: 2px solid currentColor;
		transform: rotate(-45deg);
	}
	@media (prefers-reduced-motion: no-preference) {
		.tick {
			animation-name: tick-in;
			animation-duration: var(--dur-fast);
			animation-timing-function: var(--ease-out);
		}
		@keyframes tick-in {
			from {
				opacity: 0;
				transform: rotate(-45deg) scale(0.8);
			}
		}
		/* A pressed button dips a little: immediate feedback for a tap. */
		.btn {
			transition:
				background-color var(--dur-fast) var(--ease),
				border-color var(--dur-fast) var(--ease),
				color var(--dur-fast) var(--ease),
				transform var(--dur-fast) var(--ease);
		}
		.btn:active:not(:disabled) {
			transform: scale(0.97);
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
</style>
