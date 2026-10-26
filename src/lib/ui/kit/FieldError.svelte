<!--
	FieldError: the message under one field. Renders nothing without a message. Give the field
	`aria-describedby={id}` and `aria-invalid` (TextField, TextArea and Select do this themselves).
-->
<script lang="ts">
	let { id, message }: { id: string; message?: string | null } = $props();
</script>

{#if message}
	<p {id} class="field-error">{message}</p>
{/if}

<style>
	.field-error {
		margin: 0;
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>
