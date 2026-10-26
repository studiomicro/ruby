<script lang="ts">
	import { enhance } from '$app/forms';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextArea from '#lib/ui/kit/TextArea.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import { peopleOptions } from '#lib/ui/tasks/options';

	let { data, form } = $props();
	let saving = $state(false);
	const errors = $derived((form?.errors ?? {}) as Record<string, string | undefined>);
	const values = $derived((form?.values ?? {}) as Record<string, string | undefined>);
	const leadOptions = $derived(peopleOptions(data.users, null, 'No lead'));
</script>

<PageHeader title="New project" description="Tasks in it are numbered with its key, like OPS-12." />

<form
	method="POST"
	class="panel form"
	use:enhance={() => {
		saving = true;
		return async ({ update }) => {
			await update({ reset: false });
			saving = false;
		};
	}}
>
	<Banner tone="error" message={errors.form} />
	<div class="pair">
		<!-- No maxlength: a pasted 11-character key must be refused with a message, not cut to a valid one. -->
		<TextField
			label="Key"
			name="key"
			required
			autocomplete="off"
			hint="2–10 letters or digits, starting with a letter. It cannot be changed later."
			value={values.key ?? ''}
			error={errors.key}
		/>
		<TextField
			label="Name"
			name="name"
			required
			maxlength={80}
			value={values.name ?? ''}
			error={errors.name}
		/>
	</div>
	<TextArea
		label="Description"
		name="description"
		rows={5}
		maxlength={5000}
		hint="Markdown."
		value={values.description ?? ''}
		error={errors.description}
	/>
	<Select
		label="Lead"
		name="leadId"
		options={leadOptions}
		value={values.leadId ?? data.selfId}
		error={errors.leadId}
	/>
	<div class="actions">
		<Button type="submit" variant="primary" loading={saving} loadingLabel="Creating…"
			>Create project</Button
		>
		<Button href="/projects" variant="ghost">Cancel</Button>
	</div>
</form>

<style>
	.panel {
		max-width: 720px;
		padding: 20px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.form {
		display: grid;
		gap: 16px;
	}
	.pair {
		display: grid;
		gap: 16px;
	}
	@media (min-width: 640px) {
		.pair {
			grid-template-columns: 180px minmax(0, 1fr);
		}
	}
	@media (max-width: 420px) {
		.panel {
			padding: 16px;
		}
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
