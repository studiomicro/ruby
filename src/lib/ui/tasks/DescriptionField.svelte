<!--
	DescriptionField: a Markdown textarea with a Preview tab. The preview is the same sanitising renderer the saved
	description goes through (kit Markdown). The tabs appear once JavaScript runs; without it the textarea alone
	works.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Markdown from '#lib/ui/kit/Markdown.svelte';
	import TextArea from '#lib/ui/kit/TextArea.svelte';

	let {
		name = 'description',
		label = 'Description',
		value = $bindable(''),
		error,
		maxlength,
		rows = 10
	}: {
		name?: string;
		label?: string;
		value?: string;
		error?: string | null;
		maxlength?: number;
		rows?: number;
	} = $props();

	let mounted = $state(false);
	let preview = $state(false);
	onMount(() => (mounted = true));
</script>

<div class="description-field">
	{#if mounted}
		<div class="tabs" role="group" aria-label="{label} mode">
			<button type="button" aria-pressed={!preview} onclick={() => (preview = false)}>Write</button>
			<button type="button" aria-pressed={preview} onclick={() => (preview = true)}>Preview</button>
		</div>
	{/if}
	<div class:hidden={preview}>
		<TextArea {label} {name} bind:value {error} {maxlength} {rows} mono hint="Markdown." />
	</div>
	{#if preview}
		<div class="preview" aria-live="polite">
			<Markdown source={value} empty="Nothing to preview." />
		</div>
	{/if}
</div>

<style>
	.description-field {
		display: grid;
		gap: 8px;
		min-width: 0;
	}
	.tabs {
		display: inline-flex;
		justify-self: start;
		padding: 3px;
		border-radius: var(--radius-m);
		background: var(--surface-2);
	}
	.tabs button {
		min-height: 30px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-s);
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.tabs button {
			min-height: 44px;
		}
	}
	.tabs button[aria-pressed='true'] {
		background: var(--surface);
		color: var(--fg);
		box-shadow: var(--shadow-1);
	}
	.hidden {
		display: none;
	}
	.preview {
		min-height: 120px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		background: var(--surface);
	}
</style>
