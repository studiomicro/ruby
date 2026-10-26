<!--
	Checkbox: a native checkbox with its label (Kumo Checkbox), so it posts with a plain form and works without
	JavaScript. `checked` is bindable; `value` is what the form sends (default "on"). `description` adds helper text
	under the label, `error` marks it invalid (FieldError). The box itself is the base checkbox style in app.css, so a
	bare <input type="checkbox"> in a feature looks the same. The whole row is the target (44 px on touch).
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
		required = false,
		disabled = false
	}: {
		label: string;
		name: string;
		value?: string;
		checked?: boolean;
		id?: string;
		description?: string;
		error?: string | null;
		required?: boolean;
		disabled?: boolean;
	} = $props();

	const errorId = $derived(`${id}-error`);
	const descriptionId = $derived(`${id}-description`);
	const describedBy = $derived(
		[error ? errorId : null, description ? descriptionId : null].filter(Boolean).join(' ') ||
			undefined
	);
</script>

<div class="checkbox" class:disabled>
	<input
		type="checkbox"
		{id}
		{name}
		{value}
		bind:checked
		{required}
		{disabled}
		aria-invalid={error ? true : undefined}
		aria-describedby={describedBy}
	/>
	<label for={id}>{label}</label>
	{#if description}<p id={descriptionId} class="description">{description}</p>{/if}
	{#if error}<div class="error"><FieldError id={errorId} message={error} /></div>{/if}
</div>

<style>
	.checkbox {
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr);
		column-gap: 8px;
		align-items: start;
		min-width: 0;
	}
	input {
		margin-top: 3px;
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
	/* Touch: the label row is a 44 px target; the box centres on it. */
	@media (pointer: coarse) {
		input {
			margin-top: 14px;
		}
		label {
			padding: 11px 0;
		}
	}
</style>
