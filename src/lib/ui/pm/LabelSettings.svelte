<!--
	LabelSettings: a project's labels in Settings (RB-08). Anyone can add one; renaming, recolouring and deleting are
	for the project's lead, its creator or an admin (the server checks; these controls are only a convenience).
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import { LABEL_COLORS, type LabelColor } from '#lib/shared/enums';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import type { PmAnswer } from './answer';
	import LabelChip from './LabelChip.svelte';

	type Label = { id: string; name: string; color: LabelColor; updatedAt: number };
	let {
		labels,
		canManage,
		archived,
		answer
	}: { labels: readonly Label[]; canManage: boolean; archived: boolean; answer: PmAnswer | null } =
		$props();

	const COLOR_OPTIONS = LABEL_COLORS.map((c) => ({
		value: c,
		label: c.charAt(0).toUpperCase() + c.slice(1)
	}));
	let busy = $state<string | null>(null);
	const submitting =
		(key: string, reset = false) =>
		() => {
			busy = key;
			return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
				await update({ reset });
				busy = null;
			};
		};
	const rowAnswer = (id: string) => (answer?.id === id ? answer : null);
	const createAnswer = $derived(answer && !answer.id ? answer : null);
</script>

<section class="panel" aria-labelledby="labels-heading">
	<h3 id="labels-heading">Labels</h3>
	<p class="intro">
		Tag tasks to filter the list and the board. Up to 30 per project, 10 per task.
	</p>
	{#if createAnswer}
		<Banner tone={createAnswer.ok ? 'success' : 'error'} message={createAnswer.message} />
	{/if}
	{#if labels.length === 0}
		<p class="empty">Add your first label</p>
	{:else}
		<ul class="rows">
			{#each labels as l (l.id)}
				{@const a = rowAnswer(l.id)}
				<li>
					<div class="row">
						<LabelChip name={l.name} color={l.color} />
						{#if canManage && !archived}
							<details class="edit" open={a !== null && !a.ok}>
								<summary>Edit<span class="sr-only"> label {l.name}</span></summary>
								<form
									method="POST"
									action="?/labelSave"
									class="form"
									use:enhance={submitting(`s-${l.id}`)}
								>
									<input type="hidden" name="id" value={l.id} />
									<input type="hidden" name="expectedUpdatedAt" value={l.updatedAt} />
									<TextField
										label="Name"
										name="name"
										required
										maxlength={30}
										value={a?.values?.name ?? l.name}
										error={a?.errors?.name}
									/>
									<Select
										label="Colour"
										name="color"
										options={COLOR_OPTIONS}
										value={a?.values?.color ?? l.color}
										error={a?.errors?.color}
									/>
									<div class="buttons">
										<Button type="submit" size="sm" loading={busy === `s-${l.id}`}
											>Save label</Button
										>
									</div>
								</form>
								<form method="POST" action="?/labelDelete" use:enhance={submitting(`d-${l.id}`)}>
									<input type="hidden" name="id" value={l.id} />
									<Button type="submit" size="sm" variant="danger" loading={busy === `d-${l.id}`}
										>Delete label</Button
									>
								</form>
							</details>
						{/if}
					</div>
					{#if a}<Banner tone={a.ok ? 'success' : 'error'} message={a.message} />{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if !archived}
		<form
			method="POST"
			action="?/labelSave"
			class="form create"
			use:enhance={submitting('new', true)}
		>
			<h4>New label</h4>
			<div class="pair">
				<TextField
					label="Name"
					name="name"
					required
					maxlength={30}
					value={createAnswer && !createAnswer.ok ? (createAnswer.values?.name ?? '') : ''}
					error={createAnswer && !createAnswer.ok ? createAnswer.errors?.name : undefined}
				/>
				<Select
					label="Colour"
					name="color"
					options={COLOR_OPTIONS}
					value={createAnswer && !createAnswer.ok ? (createAnswer.values?.color ?? 'gray') : 'gray'}
					error={createAnswer && !createAnswer.ok ? createAnswer.errors?.color : undefined}
				/>
			</div>
			<div class="buttons">
				<Button type="submit" loading={busy === 'new'} loadingLabel="Adding…">Add label</Button>
			</div>
		</form>
	{/if}
</section>

<style>
	.panel {
		display: grid;
		gap: 12px;
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
	h3 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	h4 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}
	.intro,
	.empty {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.rows {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 10px;
		min-width: 0;
	}
	.edit {
		margin-left: auto;
	}
	.edit[open] {
		flex: 1 0 100%;
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 10px 0;
	}
	summary {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		summary {
			min-height: 44px;
		}
	}
	.form {
		display: grid;
		gap: 10px;
	}
	.create {
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}
	.pair {
		display: grid;
		gap: 10px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
