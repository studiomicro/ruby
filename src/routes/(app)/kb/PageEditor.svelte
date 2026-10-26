<!--
	PageEditor: title and Markdown body with Write | Preview. With JavaScript the preview renders in the browser
	(through the Markdown kit component, the one renderer): side by side on a wide screen, a tab toggle below
	1100 px. Without JavaScript "Preview" submits the form to the page's `preview` action, which echoes the input and
	shows the rendered preview above the form. The form posts multipart (a long body is not percent-encoded).
	Leaving with unsaved changes asks first. `fields` adds the page's own fields (expectedRevision, a parent picker …).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { enhance } from '#lib/ui/pwa/offline-form';
	import { beforeNavigate } from '$app/navigation';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Markdown from '#lib/ui/kit/Markdown.svelte';
	import TextArea from '#lib/ui/kit/TextArea.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let {
		action,
		title: initialTitle,
		body: initialBody,
		saved,
		errors = {},
		serverPreview = null,
		submitLabel,
		savingLabel = 'Saving…',
		cancelHref,
		cancelLabel = 'Cancel',
		titleLimit,
		fields
	}: {
		/** The save action (`?/create`, `?/save`). */
		action: string;
		title: string;
		body: string;
		/** What is stored now ('' for a new page): leaving with anything else asks first. */
		saved: { title: string; body: string };
		errors?: Partial<Record<'form' | 'title' | 'body', string>>;
		/** The body the no-JS `preview` action echoed, rendered above the form. */
		serverPreview?: string | null;
		submitLabel: string;
		savingLabel?: string;
		cancelHref: string;
		cancelLabel?: string;
		titleLimit: number;
		/** The page's own fields (hidden inputs, a parent picker), placed after the body. */
		fields?: Snippet;
	} = $props();

	// Writable deriveds: they follow new server values (a refused save echoes them) and take the user's typing.
	let title = $derived(initialTitle);
	let body = $derived(initialBody);
	let js = $state(false);
	let tab = $state<'write' | 'preview'>('write');
	let saving = $state(false);
	const dirty = $derived(title !== saved.title || body !== saved.body);

	onMount(() => {
		js = true;
	});

	beforeNavigate((navigation) => {
		if (!dirty || saving) return;
		// Closing the tab or leaving the app: the browser asks itself.
		if (navigation.type === 'leave') navigation.cancel();
		else if (!confirm('Leave this page? Your changes are not saved.')) navigation.cancel();
	});
</script>

{#if serverPreview !== null}
	<section class="server-preview" aria-labelledby="server-preview-heading">
		<h2 id="server-preview-heading">Preview</h2>
		<Markdown source={serverPreview} empty="Nothing to preview yet." />
	</section>
{/if}

<form
	method="POST"
	{action}
	enctype="multipart/form-data"
	class="form"
	use:enhance={() => {
		saving = true;
		return async ({ update }) => {
			await update({ reset: false });
			saving = false;
		};
	}}
>
	<Banner tone="error" message={errors.form} />
	<TextField
		label="Title"
		name="title"
		bind:value={title}
		required
		maxlength={titleLimit}
		error={errors.title}
	/>

	<div class="editor" class:js class:show-preview={tab === 'preview'}>
		<div class="tabs" role="group" aria-label="Editor mode">
			<button
				type="button"
				class="tab write-tab"
				aria-pressed={tab === 'write'}
				onclick={() => (tab = 'write')}>Write</button
			>
			<button
				type="submit"
				formaction="?/preview"
				class="tab"
				aria-pressed={js ? tab === 'preview' : undefined}
				onclick={(event) => {
					if (!js) return;
					event.preventDefault();
					tab = 'preview';
				}}>Preview</button
			>
		</div>
		<div class="panes">
			<div class="pane write-pane">
				<TextArea
					label="Body"
					name="body"
					bind:value={body}
					rows={18}
					mono
					hint="Markdown: # headings, **bold**, lists, `code`, [links](https://example.com)."
					error={errors.body}
				/>
			</div>
			{#if js}
				<div class="pane preview-pane" aria-live="polite">
					<p class="pane-label">Preview</p>
					<div class="preview-box">
						<Markdown source={body} empty="Nothing to preview yet." />
					</div>
				</div>
			{/if}
		</div>
	</div>

	{@render fields?.()}

	<div class="actions">
		<Button type="submit" variant="primary" loading={saving} loadingLabel={savingLabel}
			>{submitLabel}</Button
		>
		<Button href={cancelHref} variant="ghost">{cancelLabel}</Button>
	</div>
</form>

<style>
	.form {
		display: grid;
		gap: 14px;
		min-width: 0;
	}
	.server-preview {
		margin-bottom: 18px;
		padding: 14px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.server-preview h2 {
		margin: 0 0 10px;
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
	}
	.editor {
		display: grid;
		gap: 8px;
		min-width: 0;
	}
	.tabs {
		display: flex;
		gap: 4px;
	}
	.tab {
		min-height: 34px;
		padding: 0 12px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-m);
		background: var(--surface);
		color: var(--fg);
		font: inherit;
		font-size: 14px;
		cursor: pointer;
	}
	.tab[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}
	@media (pointer: coarse) {
		.tab {
			min-height: 44px;
			padding: 0 16px;
		}
	}
	/* Without JavaScript only "Preview" (a submit) is offered; the body is always visible. */
	.write-tab {
		display: none;
	}
	.js .write-tab {
		display: inline-block;
	}
	.panes {
		display: grid;
		gap: 14px;
		min-width: 0;
	}
	.pane {
		min-width: 0;
	}
	.pane-label {
		margin: 0 0 6px;
		font-size: 13px;
		font-weight: 500;
	}
	.preview-box {
		min-height: 120px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		background: var(--surface);
		overflow-wrap: anywhere;
	}
	@media (max-width: 1099px) {
		.js.show-preview .write-pane,
		.js:not(.show-preview) .preview-pane {
			display: none;
		}
	}
	@media (min-width: 1100px) {
		.js .tabs {
			display: none;
		}
		.js .panes {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
