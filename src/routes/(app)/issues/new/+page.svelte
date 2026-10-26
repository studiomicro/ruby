<script lang="ts">
	import { enhance } from '$app/forms';
	import type { LabelColor } from '#lib/shared/enums';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import FieldError from '#lib/ui/kit/FieldError.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import { showToast } from '#lib/ui/kit/toast.svelte';
	import { TYPE_OPTIONS } from '#lib/ui/issues/options';
	import LabelChip from '#lib/ui/pm/LabelChip.svelte';
	import DescriptionField from '#lib/ui/tasks/DescriptionField.svelte';
	import { PRIORITY_OPTIONS } from '#lib/ui/tasks/options';

	type Label = { id: string; name: string; color: LabelColor };
	let { data, form } = $props();

	const errors = $derived((form?.errors ?? {}) as Record<string, string | undefined>);
	const echoed = $derived(form?.values);

	// What the user typed survives a project change (the project labels are swapped in place). Writable derived
	// values: reset by a new server answer, changed by the user in between.
	let projectKey = $derived(echoed?.projectKey ?? data.projectKey ?? '');
	let title = $derived(echoed?.title ?? '');
	let description = $derived(echoed?.description ?? '');
	const chosenLabels = $derived(
		new Set([...(echoed?.labelIds ?? []), ...(echoed?.teamLabelIds ?? [])])
	);

	/** The chosen project's labels: from the page for the project it opened with, then fetched on a change. */
	let projectLabels = $derived<Label[]>(data.projectLabels);
	let labelsFor = $derived<string | null>(data.projectKey);
	let labelsFailed = $state(false);

	async function projectChanged() {
		labelsFailed = false;
		if (!projectKey) {
			projectLabels = [];
			labelsFor = null;
			return;
		}
		const key = projectKey;
		try {
			const response = await fetch(`/issues/labels?project=${encodeURIComponent(key)}`);
			if (!response.ok) throw new Error(String(response.status));
			const body = (await response.json()) as { labels: Label[] };
			if (projectKey === key) {
				projectLabels = body.labels;
				labelsFor = key;
			}
		} catch {
			// Team labels stay available; the project's own cannot be shown right now.
			projectLabels = [];
			labelsFor = null;
			labelsFailed = true;
		}
	}

	let saving = $state(false);
	const projectOptions = $derived([
		{ value: '', label: 'Choose a project' },
		...data.projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` }))
	]);
</script>

<PageHeader title="Report an issue" description="It becomes a task in the project you choose." />

{#if data.projects.length === 0}
	<Banner tone="info">
		There is no active project to report into yet. <a href="/projects/new">Create a project first</a
		>.
	</Banner>
{:else}
	<noscript>
		<form method="GET" action="/issues/new" class="labels-for">
			<Select
				label="Project for labels"
				name="project"
				options={projectOptions}
				value={data.projectKey ?? ''}
			/>
			<input type="hidden" name="type" value={data.type} />
			<input type="hidden" name="priority" value={data.priority} />
			<p class="note">
				Choose the project first: this reloads the form, and what you typed is not kept.
			</p>
			<div><Button type="submit" size="sm">Show labels for this project</Button></div>
		</form>
	</noscript>
	<form
		method="POST"
		class="panel"
		use:enhance={() => {
			saving = true;
			return async ({ result, update }) => {
				if (result.type === 'redirect') {
					// The server stored the task: say so on the task page it sends us to.
					const ref = /^\/projects\/([A-Z][A-Z0-9]{1,9})\/tasks\/(\d+)/.exec(result.location);
					if (ref) showToast(`Reported ${ref[1]}-${ref[2]}`);
				}
				await update({ reset: false });
				saving = false;
			};
		}}
	>
		<input type="hidden" name="submissionId" value={echoed?.submissionId ?? data.submissionId} />
		<Banner tone="error" message={errors.form} />
		<div class="grid">
			<Select
				label="Project"
				name="projectKey"
				options={projectOptions}
				bind:value={projectKey}
				required
				error={errors.projectKey}
				onchange={projectChanged}
			/>
			<Select
				label="Type"
				name="type"
				options={TYPE_OPTIONS}
				value={echoed?.type ?? data.type}
				error={errors.type}
			/>
			<Select
				label="Priority"
				name="priority"
				options={PRIORITY_OPTIONS}
				value={echoed?.priority ?? data.priority}
				error={errors.priority}
			/>
		</div>
		<TextField
			label="Title"
			name="title"
			required
			maxlength={data.limits.title}
			bind:value={title}
			error={errors.title}
		/>
		<DescriptionField
			bind:value={description}
			maxlength={data.limits.description}
			error={errors.description}
		/>

		<fieldset class="labels" aria-describedby={errors.labels ? 'labels-error' : undefined}>
			<legend>Labels <span class="hint">(optional, up to {data.limits.labels})</span></legend>
			{#if data.teamLabels.length > 0}
				<p class="group">Team</p>
				<div class="checks">
					{#each data.teamLabels as l (l.id)}
						<label class="check"
							><input
								type="checkbox"
								name="teamLabelId"
								value={l.id}
								checked={chosenLabels.has(l.id)}
							/><LabelChip name={l.name} color={l.color} scope="team" /></label
						>
					{/each}
				</div>
			{/if}
			{#if labelsFor && projectLabels.length > 0}
				<p class="group">{labelsFor}</p>
				<div class="checks">
					{#each projectLabels as l (l.id)}
						<label class="check"
							><input
								type="checkbox"
								name="labelId"
								value={l.id}
								checked={chosenLabels.has(l.id)}
							/><LabelChip name={l.name} color={l.color} /></label
						>
					{/each}
				</div>
			{:else if data.teamLabels.length === 0}
				<p class="hint">No labels to choose from.</p>
			{/if}
			{#if labelsFailed}
				<p class="hint">
					The project's labels could not be loaded; team labels are still available.
				</p>
			{/if}
			{#if errors.labels}<FieldError id="labels-error" message={errors.labels} />{/if}
		</fieldset>

		<div class="actions">
			<Button type="submit" variant="primary" loading={saving} loadingLabel="Reporting…"
				>Report issue</Button
			>
			<Button href="/issues" variant="ghost">Cancel</Button>
		</div>
	</form>
{/if}

<style>
	.panel {
		display: grid;
		gap: 16px;
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
	.labels-for {
		display: grid;
		gap: 8px;
		max-width: 820px;
		margin-bottom: 12px;
	}
	.grid {
		display: grid;
		gap: 12px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
	}
	.note,
	.hint {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
		font-weight: 400;
	}
	.labels {
		display: grid;
		gap: 6px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 4px;
		padding: 0;
		font-size: 14px;
		font-weight: 500;
	}
	.group {
		margin: 4px 0 0;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.checks {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		min-height: 32px;
		padding: 0 10px 0 8px;
		border: 1px solid var(--border);
		border-radius: 999px;
		cursor: pointer;
	}
	.check:has(input:checked) {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	@media (pointer: coarse) {
		.check {
			min-height: 44px;
		}
	}
	.check input {
		flex: none;
		width: 16px;
		height: 16px;
		margin: 0;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	/* Phone: the submit button stays in reach, above the tab bar and the home indicator. */
	@media (max-width: 767px) {
		.actions {
			position: sticky;
			bottom: calc(var(--tabbar-h) + var(--sai-bottom));
			z-index: 2;
			margin: 0 -16px -16px;
			padding: 10px 16px;
			border-top: 1px solid var(--border);
			border-radius: 0 0 var(--radius-l) var(--radius-l);
			background: var(--surface);
		}
	}
</style>
