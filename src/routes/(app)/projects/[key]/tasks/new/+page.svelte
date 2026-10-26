<script lang="ts">
	import { enhance } from '#lib/ui/pwa/offline-form';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import DescriptionField from '#lib/ui/tasks/DescriptionField.svelte';
	import { PRIORITY_OPTIONS, STATUS_OPTIONS, peopleOptions } from '#lib/ui/tasks/options';

	let { data, form } = $props();
	let saving = $state(false);
	const errors = $derived((form?.errors ?? {}) as Record<string, string | undefined>);
	const values = $derived((form?.values ?? {}) as Record<string, string | undefined>);
	const archived = $derived(data.project.status === 'archived');
	const base = $derived(`/projects/${data.project.key}`);
</script>

<svelte:head><title>New task · {data.project.name} · Ruby</title></svelte:head>

<h2 class="heading">New task</h2>

{#if archived}
	<Banner tone="warning" message="This project is archived: no new tasks can be added." />
{:else}
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
		<TextField
			label="Title"
			name="title"
			required
			maxlength={200}
			value={values.title ?? ''}
			error={errors.title}
		/>
		<DescriptionField
			value={values.description ?? ''}
			maxlength={20000}
			error={errors.description}
		/>
		<div class="grid">
			<Select
				label="Status"
				name="status"
				options={STATUS_OPTIONS}
				value={values.status ?? data.status}
				error={errors.status}
			/>
			<Select
				label="Priority"
				name="priority"
				options={PRIORITY_OPTIONS}
				value={values.priority ?? 'none'}
				error={errors.priority}
			/>
			<Select
				label="Assignee"
				name="assigneeId"
				options={peopleOptions(data.users, null)}
				value={values.assigneeId ?? ''}
				error={errors.assigneeId}
			/>
			<TextField
				label="Due date"
				name="dueOn"
				type="date"
				value={values.dueOn ?? ''}
				error={errors.dueOn}
			/>
		</div>
		<div class="actions">
			<Button type="submit" variant="primary" loading={saving} loadingLabel="Creating…"
				>Create task</Button
			>
			<Button href={base} variant="ghost">Cancel</Button>
		</div>
	</form>
{/if}

<style>
	.heading {
		margin: 0 0 12px;
		font-size: 18px;
		font-weight: 600;
	}
	.panel {
		max-width: 820px;
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
	.form {
		display: grid;
		gap: 16px;
	}
	.grid {
		display: grid;
		gap: 12px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr));
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
