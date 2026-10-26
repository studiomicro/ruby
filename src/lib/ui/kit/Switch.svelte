<!--
	Switch: an on/off setting (Kumo Switch). A native checkbox with role="switch", so it posts like a checkbox (`value`,
	default "on", only when on) and works without JavaScript; `checked` is bindable. `description` and `error` as in
	Checkbox. Use a Checkbox for a confirmation ("Yes, delete"), a Switch for a setting. Off is a grey knob on the
	control background, on a white knob on blue; the track border meets 3:1 in both themes.
-->
<script lang="ts">
	import FieldError from './FieldError.svelte';

	const uid = $props.id();
	let {
		label,
		name,
		value,
		checked = $bindable(false),
		id = uid,
		description,
		error,
		disabled = false
	}: {
		label: string;
		name: string;
		value?: string;
		checked?: boolean;
		id?: string;
		description?: string;
		error?: string | null;
		disabled?: boolean;
	} = $props();

	const errorId = $derived(`${id}-error`);
	const descriptionId = $derived(`${id}-description`);
	const describedBy = $derived(
		[error ? errorId : null, description ? descriptionId : null].filter(Boolean).join(' ') ||
			undefined
	);
</script>

<div class="switch" class:disabled>
	<input
		type="checkbox"
		role="switch"
		{id}
		{name}
		{value}
		bind:checked
		{disabled}
		aria-invalid={error ? true : undefined}
		aria-describedby={describedBy}
	/>
	<label for={id}>{label}</label>
	{#if description}<p id={descriptionId} class="description">{description}</p>{/if}
	{#if error}<div class="error"><FieldError id={errorId} message={error} /></div>{/if}
</div>

<style>
	.switch {
		display: grid;
		grid-template-columns: 36px minmax(0, 1fr);
		column-gap: 10px;
		align-items: start;
		min-width: 0;
	}
	input {
		position: relative;
		box-sizing: border-box;
		width: 36px;
		height: 20px;
		margin: 1px 0 0;
		appearance: none;
		border: 1px solid var(--border-control);
		border-radius: 6px;
		background: var(--control);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) var(--ease),
			border-color var(--dur-fast) var(--ease);
	}
	input::before {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		width: 14px;
		height: 14px;
		border-radius: 4px;
		background: var(--muted);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.15);
		transition:
			transform var(--dur) var(--ease),
			background-color var(--dur-fast) var(--ease);
	}
	input:checked {
		border-color: var(--brand);
		background: var(--brand);
	}
	input:checked::before {
		background: var(--brand-fg);
		transform: translateX(16px);
	}
	/* Under reduced motion the thumb jumps; only its colour changes smoothly. */
	@media (prefers-reduced-motion: reduce) {
		input::before {
			transition: background-color var(--dur-fast) var(--ease);
		}
	}
	input:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	input[aria-invalid='true'] {
		border-color: var(--danger);
	}
	label {
		color: var(--fg);
		font-size: var(--text-base);
		line-height: 22px;
		cursor: pointer;
	}
	.disabled label {
		color: var(--muted);
		cursor: not-allowed;
	}
	.description,
	.error {
		grid-column: 2;
	}
	.description {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
	@media (pointer: coarse) {
		input {
			margin-top: 12px;
		}
		label {
			padding: 11px 0;
		}
	}
</style>
