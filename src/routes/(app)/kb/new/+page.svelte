<script lang="ts">
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import PageEditor from '../PageEditor.svelte';

	let { data, form } = $props();

	const space = $derived(data.project ? data.project.name : 'Team');
	const cancelHref = $derived(data.project ? `/kb/projects/${data.project.key}` : '/kb');
	const parentChoices = $derived([{ value: '', label: 'Top level' }, ...data.parents]);
	const errors = $derived(
		(form && 'errors' in form ? form.errors : {}) as Partial<
			Record<'form' | 'title' | 'body' | 'parent', string>
		>
	);
	const values = $derived(form?.values ?? { title: '', body: '', parentId: data.parentId });
</script>

<PageHeader title="New page" description="In {space}." />

<PageEditor
	action="?/create"
	title={values.title}
	body={values.body}
	saved={{ title: '', body: '' }}
	{errors}
	serverPreview={form && 'preview' in form ? (form.preview ?? null) : null}
	submitLabel="Create page"
	savingLabel="Creating…"
	{cancelHref}
	titleLimit={data.limits.title}
>
	{#snippet fields()}
		<input type="hidden" name="project" value={data.project?.key ?? ''} />
		<Select
			label="Parent page"
			name="parentId"
			options={parentChoices}
			value={values.parentId}
			error={errors.parent}
			hint="Where the page sits in {space}."
		/>
	{/snippet}
</PageEditor>
