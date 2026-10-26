<!--
	ColumnSettings: the six board columns of a project (RB-08): a display name, a soft WIP limit and hidden, saved
	as one form. The stored status never changes; an empty row is the default. A column that holds tasks cannot be
	hidden (the server refuses with the count). Managers edit; everyone else sees the current settings.
-->
<script lang="ts">
	import { enhance } from '#lib/ui/pwa/offline-form';
	import { TASK_STATUS_LABELS, type TaskStatus } from '#lib/shared/enums';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import FieldError from '#lib/ui/kit/FieldError.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import type { PmAnswer } from './answer';

	type Column = {
		status: TaskStatus;
		label: string;
		customLabel: string | null;
		wipLimit: number | null;
		hidden: boolean;
		taskCount: number;
	};
	let {
		columns,
		version,
		canManage,
		archived,
		answer
	}: {
		columns: readonly Column[];
		version: number;
		canManage: boolean;
		archived: boolean;
		answer: PmAnswer | null;
	} = $props();

	let saving = $state(false);
	const editable = $derived(canManage && !archived);
	const errors = $derived(answer && !answer.ok ? (answer.errors ?? {}) : {});
</script>

<section class="panel" aria-labelledby="columns-heading">
	<h3 id="columns-heading">Board columns</h3>
	<p class="intro">
		Rename, limit or hide the six columns on this project’s board. A WIP limit only warns; it never
		blocks a move.
	</p>
	{#if answer}<Banner tone={answer.ok ? 'success' : 'error'} message={answer.message} />{/if}
	{#if editable}
		<form
			method="POST"
			action="?/columnsSave"
			class="form"
			use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update({ reset: false });
					saving = false;
				};
			}}
		>
			<input type="hidden" name="expectedUpdatedAt" value={version} />
			{#each columns as c (c.status)}
				<fieldset class="row">
					<legend
						>{TASK_STATUS_LABELS[c.status]}
						<span class="tasks">{c.taskCount} {c.taskCount === 1 ? 'task' : 'tasks'}</span></legend
					>
					<div class="fields">
						<TextField
							label="Name"
							name="label_{c.status}"
							maxlength={24}
							placeholder={TASK_STATUS_LABELS[c.status]}
							value={c.customLabel ?? ''}
							error={errors[`label_${c.status}`]}
						/>
						<TextField
							label="WIP limit"
							name="wip_{c.status}"
							type="number"
							inputmode="numeric"
							placeholder="None"
							value={c.wipLimit === null ? '' : String(c.wipLimit)}
							error={errors[`wip_${c.status}`]}
						/>
						<div class="hide">
							<label class="check"
								><input
									type="checkbox"
									name="hidden_{c.status}"
									checked={c.hidden}
									aria-describedby={errors[`hidden_${c.status}`]
										? `hide-${c.status}-error`
										: undefined}
								/> Hidden</label
							>
							<FieldError id="hide-{c.status}-error" message={errors[`hidden_${c.status}`]} />
						</div>
					</div>
				</fieldset>
			{/each}
			<p class="hint">Leave a name or limit empty for the default.</p>
			<div>
				<Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…"
					>Save columns</Button
				>
			</div>
		</form>
	{:else}
		<dl class="read">
			{#each columns as c (c.status)}
				<dt>{TASK_STATUS_LABELS[c.status]}</dt>
				<dd>
					{c.label}{#if c.wipLimit !== null}, WIP limit {c.wipLimit}{/if}{#if c.hidden}, hidden{/if}
				</dd>
			{/each}
		</dl>
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
	.intro,
	.hint {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.form {
		display: grid;
		gap: 12px;
	}
	.row {
		margin: 0;
		padding: 10px 0 0;
		border: 0;
		border-top: 1px solid var(--border);
		min-width: 0;
	}
	legend {
		padding: 0;
		font-size: 14px;
		font-weight: 600;
	}
	.tasks {
		margin-left: 6px;
		color: var(--muted);
		font-size: 12px;
		font-weight: 400;
	}
	.fields {
		display: grid;
		gap: 10px;
		margin-top: 8px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
		align-items: end;
	}
	.hide {
		display: grid;
		gap: 4px;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 38px;
		font-size: 14px;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.check {
			min-height: 44px;
		}
	}
	.check input {
		width: 18px;
		height: 18px;
		margin: 0;
		accent-color: var(--accent);
	}
	.read {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 6px 12px;
		margin: 0;
		font-size: 14px;
	}
	.read dt {
		color: var(--muted);
	}
	.read dd {
		margin: 0;
	}
</style>
