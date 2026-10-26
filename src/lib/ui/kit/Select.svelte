<!--
	Select: a labelled native <select>. `options` are `{ value, label }` pairs (an enum list and its labels, or users).
	`value` is bindable. Same `error`/`hint` contract as TextField. `onchange` lets a tiny form submit itself. A choice
	made before the page hydrated survives hydration (RB-06 QA D1).
-->
<script lang="ts">
	import FieldError from './FieldError.svelte';

	const uid = $props.id();
	let {
		label,
		name,
		options,
		value = $bindable(''),
		id = uid,
		error,
		hint,
		required = false,
		disabled = false,
		hideLabel = false,
		onchange
	}: {
		label: string;
		name: string;
		options: readonly { value: string; label: string }[];
		value?: string;
		id?: string;
		error?: string | null;
		hint?: string;
		required?: boolean;
		disabled?: boolean;
		hideLabel?: boolean;
		onchange?: (event: Event & { currentTarget: HTMLSelectElement }) => void;
	} = $props();

	/**
	 * RB-06 QA D1: on a slow phone the user can change the server-rendered <select> before hydration, and Svelte's
	 * `bind:value` would then put the initial value back (it does adopt such edits for inputs and checkboxes, not for
	 * selects). While hydrating, the server's element is already in the document under this id: when its chosen
	 * option is no longer the one the server marked `selected`, the user changed it, so that choice becomes `value`
	 * before the binding runs. A client-rendered Select finds no such element and keeps its value.
	 */
	function adoptChoiceMadeBeforeHydration() {
		if (typeof document === 'undefined') return;
		const rendered = document.getElementById(id);
		if (!(rendered instanceof HTMLSelectElement) || rendered.multiple) return;
		const chosen = rendered.selectedOptions[0];
		if (chosen && !chosen.defaultSelected && chosen.value !== value) value = chosen.value;
	}
	adoptChoiceMadeBeforeHydration();

	const errorId = $derived(`${id}-error`);
	const hintId = $derived(`${id}-hint`);
	const describedBy = $derived(
		[error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="field">
	<label for={id} class:sr-only={hideLabel}>{label}</label>
	<span class="control">
		<select
			{id}
			{name}
			bind:value
			{required}
			{disabled}
			{onchange}
			aria-invalid={error ? true : undefined}
			aria-describedby={describedBy}
		>
			{#each options as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
	</span>
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
	/* Kumo Select: the Input's box with a chevron; still the native control (keyboard, phones, no JS). */
	.control {
		position: relative;
		display: grid;
		min-width: 0;
	}
	.control::after {
		content: '';
		position: absolute;
		top: 50%;
		right: 13px;
		width: 6px;
		height: 6px;
		margin-top: -5px;
		border-right: 1.5px solid var(--muted);
		border-bottom: 1.5px solid var(--muted);
		transform: rotate(45deg);
		pointer-events: none;
	}
	select {
		width: 100%;
		min-width: 0;
		min-height: 36px;
		padding: 0 34px 0 12px;
		box-sizing: border-box;
		appearance: none;
		border: 1px solid var(--border-control);
		border-radius: var(--radius-m);
		background: var(--control);
		color: var(--fg);
		font: inherit;
		/* iOS zooms into a field under 16 px (app.css). */
		font-size: max(16px, 1em);
		text-overflow: ellipsis;
		cursor: pointer;
		transition:
			border-color var(--dur-fast) var(--ease),
			box-shadow var(--dur-fast) var(--ease);
	}
	@media (pointer: coarse) {
		select {
			min-height: 44px;
		}
	}
	select:focus {
		outline: none;
		border-color: var(--field-focus);
		box-shadow: 0 0 0 0.5px var(--field-focus);
	}
	select:focus-visible {
		outline: none;
	}
	select[aria-invalid='true'] {
		border-color: var(--danger);
	}
	select:disabled {
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
