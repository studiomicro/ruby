<script lang="ts">
	import { enhance } from '$app/forms';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextArea from '#lib/ui/kit/TextArea.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import { peopleOptions } from '#lib/ui/tasks/options';
	import { answerFor } from '#lib/ui/pm/answer';
	import ColumnSettings from '#lib/ui/pm/ColumnSettings.svelte';
	import LabelSettings from '#lib/ui/pm/LabelSettings.svelte';
	import MilestoneSettings from '#lib/ui/pm/MilestoneSettings.svelte';

	let { data, form } = $props();
	let saving = $state(false);
	let archiving = $state(false);
	const errors = $derived(
		(form && 'errors' in form ? (form.errors ?? {}) : {}) as Record<string, string | undefined>
	);
	const values = $derived(
		(form && 'values' in form ? (form.values ?? {}) : {}) as Record<string, string | undefined>
	);
	const archived = $derived(data.project.status === 'archived');
	const leadOptions = $derived(
		peopleOptions(data.users, { id: data.project.leadId, name: data.project.leadName }, 'No lead')
	);
</script>

<h2 class="heading">Settings</h2>

<div class="sections">
	<Banner tone="success" message={form && 'saved' in form ? form.saved : null} />
	<Banner tone="error" message={errors.form} />

	{#if !data.canManage}
		<Banner
			tone="info"
			message="Only the project lead, its creator or an admin can change the project, its milestones and its board columns. Anyone can add labels."
		/>
	{/if}

	<form
		method="POST"
		action="?/update"
		class="panel form"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				await update({ reset: false });
				saving = false;
			};
		}}
	>
		<input type="hidden" name="expectedUpdatedAt" value={data.project.updatedAt} />
		<TextField
			label="Key"
			name="keyShown"
			value={data.project.key}
			readonly
			hint="The key is fixed: task numbers and links use it."
		/>
		<TextField
			label="Name"
			name="name"
			required
			maxlength={80}
			value={values.name ?? data.project.name}
			error={errors.name}
			disabled={!data.canManage}
		/>
		<TextArea
			label="Description"
			name="description"
			rows={5}
			maxlength={5000}
			hint="Markdown."
			value={values.description ?? data.project.description}
			error={errors.description}
			disabled={!data.canManage}
		/>
		<Select
			label="Lead"
			name="leadId"
			options={leadOptions}
			value={values.leadId ?? data.project.leadId ?? ''}
			error={errors.leadId}
			disabled={!data.canManage}
		/>
		{#if data.canManage}
			<div>
				<Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…"
					>Save project</Button
				>
			</div>
		{/if}
	</form>

	<LabelSettings
		labels={data.labels}
		canManage={data.canManage}
		{archived}
		answer={answerFor(form, 'labels')}
	/>
	<MilestoneSettings
		milestones={data.milestones}
		base="/projects/{data.project.key}"
		today={data.today}
		canManage={data.canManage}
		{archived}
		answer={answerFor(form, 'milestones')}
	/>
	<ColumnSettings
		columns={data.columns.columns}
		version={data.columns.version}
		canManage={data.canManage}
		{archived}
		answer={answerFor(form, 'columns')}
	/>

	{#if data.canManage}
		<form
			method="POST"
			action={archived ? '?/unarchive' : '?/archive'}
			class="panel archive"
			use:enhance={() => {
				archiving = true;
				return async ({ update }) => {
					await update();
					archiving = false;
				};
			}}
		>
			<input type="hidden" name="expectedUpdatedAt" value={data.project.updatedAt} />
			<h3>{archived ? 'Unarchive project' : 'Archive project'}</h3>
			<p>
				{archived
					? 'Tasks become editable again and the project returns to the project list.'
					: 'Its tasks become read-only and it moves to the archived list. You can unarchive it later.'}
			</p>
			<div>
				<Button type="submit" variant={archived ? 'secondary' : 'danger'} loading={archiving}
					>{archived ? 'Unarchive' : 'Archive'}</Button
				>
			</div>
		</form>
	{/if}
</div>

<style>
	.heading {
		margin: 0 0 12px;
		font-size: 18px;
		font-weight: 600;
	}
	.sections {
		display: grid;
		gap: 16px;
		max-width: 720px;
	}
	.panel {
		padding: 20px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	@media (max-width: 420px) {
		.panel {
			padding: 16px;
		}
	}
	.form,
	.archive {
		display: grid;
		gap: 14px;
	}
	h3 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.archive p {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
</style>
