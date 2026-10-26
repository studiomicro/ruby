<!--
	TextArea: a labelled multi-line input (task descriptions, page bodies, comments). Same contract as TextField:
	`error`, `hint`, bindable `value`, generated id. `mono` uses the code font (a Markdown source editor).
-->
<script lang="ts">
	import FieldError from './FieldError.svelte';

	const uid = $props.id();
	let {
		label,
		name,
		value = $bindable(''),
		id = uid,
		rows = 6,
		error,
		hint,
		required = false,
		disabled = false,
		placeholder,
		maxlength,
		mono = false,
		hideLabel = false
	}: {
		label: string;
		name: string;
		value?: string;
		id?: string;
		rows?: number;
		error?: string | null;
		hint?: string;
		required?: boolean;
		disabled?: boolean;
		placeholder?: string;
		maxlength?: number;
		mono?: boolean;
		hideLabel?: boolean;
	} = $props();

	const errorId = $derived(`${id}-error`);
	const hintId = $derived(`${id}-hint`);
	const describedBy = $derived(
		[error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="field">
	<label for={id} class:sr-only={hideLabel}>{label}</label>
	<textarea
		{id}
		{name}
		{rows}
		bind:value
		{required}
		{disabled}
		{placeholder}
		{maxlength}
		class:mono
		aria-invalid={error ? true : undefined}
		aria-describedby={describedBy}></textarea>
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
	/* Kumo InputArea: the Input's border, background and focus ring. */
	textarea {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		padding: 8px 12px;
		border: 1px solid var(--border-control);
		border-radius: var(--radius-m);
		background: var(--control);
		color: var(--fg);
		font: inherit;
		/* iOS zooms into a field under 16 px (app.css). */
		font-size: max(16px, 1em);
		line-height: 1.5;
		resize: vertical;
		transition:
			border-color var(--dur-fast) var(--ease),
			box-shadow var(--dur-fast) var(--ease);
	}
	textarea.mono {
		font-family: var(--font-mono);
		font-size: max(16px, 0.9em);
	}
	textarea::placeholder {
		color: var(--subtle);
	}
	textarea:focus {
		outline: none;
		border-color: var(--field-focus);
		box-shadow: 0 0 0 0.5px var(--field-focus);
	}
	textarea:focus-visible {
		outline: none;
	}
	textarea[aria-invalid='true'] {
		border-color: var(--danger);
	}
	textarea[aria-invalid='true']:focus {
		box-shadow: 0 0 0 0.5px var(--danger);
	}
	textarea:disabled {
		background: var(--surface-2);
		color: var(--muted);
		cursor: not-allowed;
	}
	.hint {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
</style>
