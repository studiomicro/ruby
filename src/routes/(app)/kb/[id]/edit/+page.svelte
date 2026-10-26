<script lang="ts">
	import type { CurrentVersion } from '#lib/server/kb/repo';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Markdown from '#lib/ui/kit/Markdown.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Breadcrumbs from '../../Breadcrumbs.svelte';
	import PageEditor from '../../PageEditor.svelte';

	let { data, form } = $props();

	const page = $derived(data.page);
	const conflict = $derived((form as { conflict?: CurrentVersion } | null)?.conflict ?? null);
	const errors = $derived(
		(form && 'errors' in form ? form.errors : {}) as Partial<
			Record<'form' | 'title' | 'body', string>
		>
	);
	const values = $derived(
		form?.values ?? {
			title: page.title,
			body: page.body,
			expectedRevision: String(page.revision)
		}
	);
	/** After a conflict the next save is made against the revision the user has now seen. */
	const expectedRevision = $derived(conflict ? String(conflict.revision) : values.expectedRevision);
</script>

<Breadcrumbs project={page.project} ancestors={data.breadcrumbs} current={page} />
<PageHeader title={conflict ? 'Edit conflict' : `Edit “${page.title}”`} />

{#if conflict}
	<Banner tone="warning">
		This page was changed by {conflict.editedByName ?? 'someone else'} while you were editing (now revision
		{conflict.revision}). Compare the versions, then save yours over theirs or discard it.
	</Banner>
{/if}

<div class="layout" class:conflict>
	<section class="mine" aria-labelledby="mine-heading">
		{#if conflict}<h2 id="mine-heading">Your version</h2>{/if}
		<PageEditor
			action="?/save"
			title={values.title}
			body={values.body}
			saved={{ title: page.title, body: page.body }}
			{errors}
			serverPreview={form && 'preview' in form ? (form.preview ?? null) : null}
			submitLabel={conflict ? 'Save mine over theirs' : 'Save'}
			cancelHref="/kb/{page.id}"
			cancelLabel={conflict ? 'Discard mine' : 'Cancel'}
			titleLimit={data.limits.title}
		>
			{#snippet fields()}
				<input type="hidden" name="expectedRevision" value={expectedRevision} />
			{/snippet}
		</PageEditor>
	</section>

	{#if conflict}
		<section class="theirs" aria-labelledby="theirs-heading">
			<h2 id="theirs-heading">Current version (revision {conflict.revision})</h2>
			<p class="current-title">{conflict.title}</p>
			<div class="rendered">
				<Markdown source={conflict.body} empty="The current version is empty." />
			</div>
			<details class="raw">
				<summary>Show Markdown source</summary>
				<pre>{conflict.body}</pre>
			</details>
		</section>
	{/if}
</div>

<style>
	.layout {
		display: grid;
		gap: 24px;
		min-width: 0;
	}
	.layout > section {
		min-width: 0;
	}
	.conflict {
		margin-top: 16px;
	}
	@media (min-width: 1100px) {
		.layout.conflict {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: start;
		}
	}
	h2 {
		margin: 0 0 10px;
		font-size: 15px;
		font-weight: 600;
	}
	.theirs {
		padding: 14px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.current-title {
		margin: 0 0 10px;
		font-size: 18px;
		font-weight: 600;
	}
	.rendered {
		margin-bottom: 12px;
	}
	.raw summary {
		display: flex;
		align-items: center;
		min-height: 36px;
		color: var(--muted);
		font-size: 14px;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.raw summary {
			min-height: 44px;
		}
	}
	.raw pre {
		max-height: 50dvh;
		overflow: auto;
		margin: 8px 0 0;
		padding: 10px 12px;
		border-radius: var(--radius-m);
		background: var(--surface-2);
		font-family: var(--font-mono);
		font-size: 13px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
