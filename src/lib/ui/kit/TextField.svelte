<!--
	TextField: a labelled single-line input. `error` shows under it (FieldError) and marks it invalid; `hint` is
	helper text. `value` is bindable; for a no-JS form pass the server's echoed value. The id is generated unless
	given, and the label is always tied to the input.
-->
<script lang="ts">
	import type { FullAutoFill, HTMLInputAttributes } from 'svelte/elements';
	import FieldError from './FieldError.svelte';

	const uid = $props.id();
	let {
		label,
		name,
		value = $bindable(''),
		type = 'text',
		id = uid,
		error,
		hint,
		required = false,
		disabled = false,
		readonly = false,
		autocomplete,
		inputmode,
		placeholder,
		maxlength,
		minlength,
		autofocus = false,
		hideLabel = false,
		step
	}: {
		label: string;
		name: string;
		value?: string;
		type?: 'text' | 'email' | 'password' | 'search' | 'url' | 'date' | 'time' | 'number';
		id?: string;
		error?: string | null;
		hint?: string;
		required?: boolean;
		disabled?: boolean;
		readonly?: boolean;
		autocomplete?: FullAutoFill;
		inputmode?: HTMLInputAttributes['inputmode'];
		placeholder?: string;
		maxlength?: number;
		minlength?: number;
		autofocus?: boolean;
		/** Keeps the label for screen readers only (a search box with a visible placeholder). */
		hideLabel?: boolean;
		/** The input's `step` (a `time` field in 5-minute steps: 300). */
		step?: number;
	} = $props();

	const errorId = $derived(`${id}-error`);
	const hintId = $derived(`${id}-hint`);
	const describedBy = $derived(
		[error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="field">
	<label for={id} class:sr-only={hideLabel}>{label}</label>
	<!-- svelte-ignore a11y_autofocus -->
	<input
		{id}
		{name}
		{type}
		bind:value
		{required}
		{disabled}
		{readonly}
		{autocomplete}
		{inputmode}
		{placeholder}
		{maxlength}
		{minlength}
		{autofocus}
		{step}
		aria-invalid={error ? true : undefined}
		aria-describedby={describedBy}
	/>
	{#if hint}<p id={hintId} class="hint">{hint}</p>{/if}
	<FieldError id={errorId} message={error} />
</div>

<style>
	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	label {
		color: var(--fg);
		font-size: var(--text-base);
		font-weight: 500;
	}
	/* Kumo Input: 36 px, control background, 1 px border; a 1.5 px neutral ring while focused. */
	input {
		width: 100%;
		min-width: 0;
		min-height: 36px;
		padding: 0 12px;
		box-sizing: border-box;
		border: 1px solid var(--border-control);
		border-radius: var(--radius-m);
		background: var(--control);
		color: var(--fg);
		font: inherit;
		/* iOS zooms into a field under 16 px (app.css). */
		font-size: max(16px, 1em);
		transition:
			border-color var(--dur-fast) var(--ease),
			box-shadow var(--dur-fast) var(--ease);
	}
	@media (pointer: coarse) {
		input {
			min-height: 44px;
		}
	}
	input::placeholder {
		color: var(--subtle);
	}
	input:focus {
		outline: none;
		border-color: var(--field-focus);
		box-shadow: 0 0 0 0.5px var(--field-focus);
	}
	input:focus-visible {
		outline: none;
	}
	input[aria-invalid='true'] {
		border-color: var(--danger);
	}
	input[aria-invalid='true']:focus {
		box-shadow: 0 0 0 0.5px var(--danger);
	}
	input:disabled,
	input:read-only {
		background: var(--surface-2);
		color: var(--muted);
	}
	input:disabled {
		cursor: not-allowed;
	}
	.hint {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
</style>
