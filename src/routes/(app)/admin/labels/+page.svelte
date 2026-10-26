<script lang="ts">
	import { enhance } from '$app/forms';
	import { LABEL_COLORS } from '#lib/shared/enums';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Card from '#lib/ui/kit/Card.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import { showToast } from '#lib/ui/kit/toast.svelte';
	import { answerFor } from '#lib/ui/pm/answer';
	import LabelChip from '#lib/ui/pm/LabelChip.svelte';

	let { data, form } = $props();

	const COLOR_OPTIONS = LABEL_COLORS.map((c) => ({
		value: c,
		label: c.charAt(0).toUpperCase() + c.slice(1)
	}));
	const created = $derived(answerFor(form, 'create'));
	const full = $derived(data.labels.length >= data.max);
	let busy = $state<string | null>(null);

	/** A form's submit: the busy marker while it runs, a toast once the server confirmed the write. */
	const submit = (key: string) => () => {
		busy = key;
		return async ({
			result,
			update
		}: {
			result: { type: string; data?: Record<string, unknown> };
			update: (o?: { reset?: boolean }) => Promise<void>;
		}) => {
			await update({ reset: key === 'create' });
			busy = null;
			const pm = (result.data as { pm?: { ok: boolean; message: string } } | undefined)?.pm;
			if (result.type === 'success' && pm?.ok) showToast(pm.message);
		};
	};
</script>

<PageHeader
	title="Team labels"
	description="Labels every project can use. Anyone can put them on a task; only admins change the list."
/>

<div class="stack">
	<Card title="Add a team label">
		{#if full}
			<Banner tone="info" message="The team has {data.max} team labels, the most it can have." />
		{:else}
			<form method="POST" action="?/create" class="create" use:enhance={submit('create')}>
				<Banner tone="success" message={created?.ok ? created.message : null} />
				<Banner tone="error" message={created && !created.ok ? created.message : null} />
				<div class="fields">
					<TextField
						label="Name"
						name="name"
						required
						maxlength={data.nameMax}
						value={created && !created.ok ? (created.values?.name ?? '') : ''}
						error={created && !created.ok ? created.errors?.name : undefined}
					/>
					<Select
						label="Colour"
						name="color"
						options={COLOR_OPTIONS}
						value={created && !created.ok ? (created.values?.color ?? 'blue') : 'blue'}
						error={created && !created.ok ? created.errors?.color : undefined}
					/>
				</div>
				<div>
					<Button type="submit" variant="primary" loading={busy === 'create'} loadingLabel="Adding…"
						>Add label</Button
					>
				</div>
			</form>
		{/if}
	</Card>

	{#if data.labels.length === 0}
		<EmptyState
			title="No team labels yet"
			description="Add one above, like “Customer” or “Security”, and use it in any project."
		/>
	{:else}
		<Card title="{data.labels.length} of {data.max} team labels" flush>
			<ul class="rows">
				{#each data.labels as l (l.id)}
					{@const answer = answerFor(form, 'row', l.id)}
					<li class="row">
						<div class="head">
							<LabelChip name={l.name} color={l.color} scope="team" />
							<span class="used">Used on {l.used} {l.used === 1 ? 'task' : 'tasks'}</span>
						</div>
						<Banner tone={answer?.ok ? 'success' : 'error'} message={answer?.message ?? null} />
						<details>
							<summary>Edit or delete<span class="sr-only"> {l.name}</span></summary>
							<form method="POST" action="?/update" class="edit" use:enhance={submit(`u-${l.id}`)}>
								<input type="hidden" name="id" value={l.id} />
								<input type="hidden" name="expectedUpdatedAt" value={l.updatedAt} />
								<div class="fields">
									<TextField
										label="Name"
										name="name"
										required
										maxlength={data.nameMax}
										value={answer && !answer.ok ? (answer.values?.name ?? l.name) : l.name}
										error={answer && !answer.ok ? answer.errors?.name : undefined}
									/>
									<Select
										label="Colour"
										name="color"
										options={COLOR_OPTIONS}
										value={answer && !answer.ok ? (answer.values?.color ?? l.color) : l.color}
										error={answer && !answer.ok ? answer.errors?.color : undefined}
									/>
								</div>
								<div>
									<Button type="submit" loading={busy === `u-${l.id}`} loadingLabel="Saving…"
										>Save</Button
									>
								</div>
							</form>
							<form
								method="POST"
								action="?/delete"
								class="delete"
								use:enhance={submit(`d-${l.id}`)}
							>
								<input type="hidden" name="id" value={l.id} />
								<label class="confirm"
									><input type="checkbox" name="confirm" value="yes" required /> Delete “{l.name}”,
									used on {l.used}
									{l.used === 1 ? 'task' : 'tasks'}. It leaves every task; this cannot be undone.</label
								>
								<div>
									<Button
										type="submit"
										variant="danger"
										loading={busy === `d-${l.id}`}
										loadingLabel="Deleting…">Delete label</Button
									>
								</div>
							</form>
						</details>
					</li>
				{/each}
			</ul>
		</Card>
	{/if}
</div>

<style>
	.stack {
		display: grid;
		gap: 16px;
		max-width: 820px;
	}
	.create,
	.edit,
	.delete {
		display: grid;
		gap: 12px;
	}
	.fields {
		display: grid;
		gap: 12px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.row {
		display: grid;
		gap: 8px;
		min-width: 0;
		padding: 12px 16px;
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 6px 12px;
		min-width: 0;
	}
	.used {
		color: var(--muted);
		font-size: 13px;
	}
	summary {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		color: var(--accent);
		font-size: 13px;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		summary {
			min-height: 44px;
		}
	}
	details[open] {
		display: grid;
		gap: 14px;
	}
	.delete {
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}
	.confirm {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		min-height: 44px;
		font-size: 14px;
	}
	.confirm input {
		flex: none;
		margin-top: 3px;
	}
</style>
