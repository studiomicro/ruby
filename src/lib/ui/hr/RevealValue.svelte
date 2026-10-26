<!--
	RevealValue: one masked tier 2 / tier 3 value with a Reveal button. The button posts the profile's `?/reveal`
	action (audited on the server); with JavaScript the value replaces the mask and hides again after 30 seconds,
	without it the action's result page shows the value once (`revealed`). The value never comes from a page load.
-->
<script lang="ts">
	import { enhance } from '#lib/ui/pwa/offline-form';
	import { onDestroy } from 'svelte';

	const HIDE_AFTER_MS = 30_000;

	let {
		action,
		field,
		ref = '',
		label,
		masked,
		empty = false,
		disabled = false,
		revealed = null,
		multiline = false
	}: {
		/** The reveal action URL, e.g. `/people/<id>?/reveal`. */
		action: string;
		field: string;
		/** The contact or salary record the field belongs to. */
		ref?: string;
		label: string;
		masked: string;
		/** Nothing stored: no button. */
		empty?: boolean;
		/** The key is not configured: the button is shown disabled. */
		disabled?: boolean;
		/** A value revealed by a no-JavaScript submit of this very field. */
		revealed?: string | null;
		multiline?: boolean;
	} = $props();

	let value = $state<string | null>(null);
	let pending = $state(false);
	let problem = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const shown = $derived(value ?? revealed);

	function hide() {
		value = null;
		clearTimeout(timer);
	}
	onDestroy(() => clearTimeout(timer));
</script>

<div class="reveal">
	<span class="value" class:multiline class:masked={shown === null} aria-live="polite">
		{#if empty}<span class="none">Not set</span>{:else}{shown ?? masked}{/if}
	</span>
	{#if !empty}
		{#if shown !== null && value !== null}
			<button type="button" class="link" onclick={hide}>Hide</button>
		{:else if shown === null}
			<form
				method="POST"
				{action}
				use:enhance={() => {
					pending = true;
					problem = null;
					return async ({ result }) => {
						pending = false;
						if (result.type === 'success') {
							const data = result.data as { revealed?: { value: string } } | undefined;
							value = data?.revealed?.value ?? null;
							clearTimeout(timer);
							timer = setTimeout(hide, HIDE_AFTER_MS);
						} else if (result.type === 'failure') {
							problem =
								(result.data as { revealError?: string } | undefined)?.revealError ??
								'Could not reveal this value.';
						} else {
							problem = 'Could not reveal this value.';
						}
					};
				}}
			>
				<input type="hidden" name="field" value={field} />
				<input type="hidden" name="ref" value={ref} />
				<button
					type="submit"
					class="link"
					disabled={disabled || pending}
					aria-label="Reveal {label}">{pending ? 'Revealing…' : 'Reveal'}</button
				>
			</form>
		{/if}
	{/if}
</div>
{#if problem}<p class="problem" role="alert">{problem}</p>{/if}

<style>
	.reveal {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 10px;
		min-width: 0;
	}
	.value {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.value.masked {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.multiline {
		white-space: pre-line;
	}
	.none {
		color: var(--muted);
	}
	.link {
		min-height: 32px;
		padding: 0 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		background: var(--surface);
		color: var(--fg);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.link:hover:not(:disabled) {
		background: var(--surface-2);
	}
	.link:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
	@media (pointer: coarse) {
		.link {
			min-height: 44px;
			padding: 0 14px;
		}
	}
	.problem {
		margin: 4px 0 0;
		color: var(--danger);
		font-size: 13px;
	}
</style>
