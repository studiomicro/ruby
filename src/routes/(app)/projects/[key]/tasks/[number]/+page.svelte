<script lang="ts">
	import type { SubmitFunction } from '$app/forms';
	import { enhance } from '#lib/ui/pwa/offline-form';
	import AttachmentPanel from '#lib/ui/attachments/AttachmentPanel.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import Markdown from '#lib/ui/kit/Markdown.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import Assignee from '#lib/ui/tasks/Assignee.svelte';
	import DescriptionField from '#lib/ui/tasks/DescriptionField.svelte';
	import Due from '#lib/ui/tasks/Due.svelte';
	import Priority from '#lib/ui/tasks/Priority.svelte';
	import StatusBadge from '#lib/ui/tasks/StatusBadge.svelte';
	import { PRIORITY_OPTIONS, STATUS_OPTIONS, peopleOptions } from '#lib/ui/tasks/options';
	import CommentThread from '#lib/ui/comments/CommentThread.svelte';
	import { answerFor } from '#lib/ui/pm/answer';
	import LabelChip from '#lib/ui/pm/LabelChip.svelte';
	import TaskChecklist from '#lib/ui/pm/TaskChecklist.svelte';
	import TaskLabelsField from '#lib/ui/pm/TaskLabelsField.svelte';
	import ReminderPanel from '#lib/ui/calendar/ReminderPanel.svelte';

	let { data, form } = $props();

	const base = $derived(`/projects/${data.project.key}`);
	const self = $derived(`${base}/tasks/${data.task.number}`);
	const archived = $derived(data.project.status === 'archived');
	const editing = $derived(data.editing && !archived);
	const errors = $derived(
		(form && 'errors' in form ? form.errors : {}) as Record<string, string | undefined>
	);
	const values = $derived(
		(form && 'values' in form ? form.values : {}) as Record<string, string | null | undefined>
	);
	const conflict = $derived(form && 'conflict' in form ? form.conflict : null);
	const formError = $derived(form && 'formError' in form ? form.formError : null);
	const patched = $derived(form && 'patched' in form ? form.patched : null);
	const assigneeOptions = $derived(
		peopleOptions(data.users, { id: data.task.assigneeId, name: data.task.assigneeName })
	);

	// RB-08: open milestones, plus the task's own (it may be closed).
	const milestoneOptions = $derived([
		{ value: '', label: 'None' },
		...data.milestones
			.filter((m) => m.status === 'open' || m.id === data.task.milestoneId)
			.map((m) => ({ value: m.id, label: m.status === 'closed' ? `${m.name} (closed)` : m.name }))
	]);

	let saving = $state(false);
	let savingField = $state<string | null>(null);
	let deleting = $state(false);

	const patchSubmit: SubmitFunction = ({ formData }) => {
		savingField = String(formData.get('field'));
		return async ({ update }) => {
			await update({ reset: false });
			savingField = null;
		};
	};
	const autoSubmit = (event: Event & { currentTarget: HTMLFormElement }) =>
		event.currentTarget.requestSubmit();
	const resubmitValue = (v: unknown) => (v === null || v === undefined ? '' : String(v));
</script>

<svelte:head><title>{data.ref} {data.task.title} · Ruby</title></svelte:head>

<header class="task-header">
	<h1><span class="ref">{data.ref}</span> {data.task.title}</h1>
	<div class="chips">
		<StatusBadge status={data.task.status} />
		<Priority priority={data.task.priority} />
	</div>
</header>

<div class="banners">
	<Banner tone="success" message={data.saved && !form ? 'Task saved.' : null} />
	<Banner tone="error" message={formError} />
</div>

{#if conflict}
	<section class="conflict" aria-labelledby="conflict-heading" role="alert">
		<h2 id="conflict-heading">This task was changed meanwhile</h2>
		<p>Nothing was saved. Compare the current version with yours, then choose one.</p>
		{#if conflict.fields.length > 0}
			<div class="diff">
				{#each conflict.fields as f (f.field)}
					<div class="diff-row">
						<h3>{f.label}</h3>
						<div class="sides">
							<div>
								<p class="side-label">Current</p>
								<p class="value" class:long={f.field === 'description'}>{f.theirs}</p>
							</div>
							<div>
								<p class="side-label">Yours</p>
								<p class="value" class:long={f.field === 'description'}>{f.mine}</p>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
		<div class="conflict-actions">
			<Button href={self} variant="secondary">Use theirs</Button>
			<form method="POST" action="?/{form?.kind === 'patch' ? 'patch' : 'update'}" use:enhance>
				<input type="hidden" name="expectedUpdatedAt" value={conflict.expectedUpdatedAt} />
				{#if form?.kind === 'patch'}
					{@const [field, value] = Object.entries(conflict.mine)[0] ?? ['', '']}
					<input type="hidden" name="field" value={field} />
					<input type="hidden" name="value" value={resubmitValue(value)} />
				{:else}
					{#each Object.entries(conflict.mine) as [name, value] (name)}
						<input type="hidden" {name} value={resubmitValue(value)} />
					{/each}
				{/if}
				<Button type="submit" variant="primary">Keep mine</Button>
			</form>
		</div>
	</section>
{/if}

<div class="layout">
	<section class="main" aria-label="Description">
		{#if editing}
			<form
				method="POST"
				action="?/update"
				class="edit"
				use:enhance={() => {
					saving = true;
					return async ({ update }) => {
						await update({ reset: false });
						saving = false;
					};
				}}
			>
				<input type="hidden" name="expectedUpdatedAt" value={data.task.updatedAt} />
				<TextField
					label="Title"
					name="title"
					required
					maxlength={200}
					value={values.title ?? data.task.title}
					error={errors.title}
				/>
				<DescriptionField
					value={values.description ?? data.task.description}
					maxlength={20000}
					error={errors.description}
				/>
				<div class="row-actions">
					<Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…"
						>Save</Button
					>
					<Button href={self} variant="ghost">Cancel</Button>
				</div>
			</form>
		{:else}
			<div class="description">
				<Markdown source={data.task.description} names={data.names} empty="No description." />
			</div>
			<!-- RB-04:attachments -->
			<AttachmentPanel panel={data.attachments} />
			<footer class="desc-footer">
				{#if !archived}<Button href="{self}?edit=1" size="sm">Edit</Button>{/if}
			</footer>
		{/if}
	</section>

	<div class="steps">
		<TaskChecklist
			items={data.checklist}
			{archived}
			answer={answerFor(form, 'checklist')}
			max={data.pmLimits.steps}
		/>
	</div>

	<aside class="fields" aria-label="Task fields">
		{#if archived}
			<dl>
				<dt>Status</dt>
				<dd><StatusBadge status={data.task.status} /></dd>
				<dt>Priority</dt>
				<dd><Priority priority={data.task.priority} /></dd>
				<dt>Assignee</dt>
				<dd><Assignee id={data.task.assigneeId} name={data.task.assigneeName} /></dd>
				<dt>Due date</dt>
				<dd>
					<Due dueOn={data.task.dueOn} status={data.task.status} today={data.today} empty="None" />
				</dd>
				<dt>Milestone</dt>
				<dd>{data.task.milestoneName ?? 'None'}</dd>
				<dt>Labels</dt>
				<dd class="chip-list">
					{#each data.task.labels as l (l.id)}<LabelChip
							name={l.name}
							color={l.color}
						/>{:else}None{/each}
				</dd>
			</dl>
		{:else}
			{#snippet patchForm(field: string, saved: boolean, control: import('svelte').Snippet)}
				<form
					method="POST"
					action="?/patch"
					class="patch"
					onchange={autoSubmit}
					use:enhance={patchSubmit}
				>
					<input type="hidden" name="field" value={field} />
					<input type="hidden" name="expectedUpdatedAt" value={data.task.updatedAt} />
					{@render control()}
					<noscript><Button type="submit" size="sm">Save</Button></noscript>
					<p class="state" aria-live="polite">
						{#if savingField === field}Saving…{:else if saved}Saved{/if}
					</p>
				</form>
			{/snippet}

			{#snippet statusControl()}
				<Select
					label="Status"
					name="value"
					options={STATUS_OPTIONS}
					value={data.task.status}
					error={errors.status}
				/>
			{/snippet}
			{#snippet priorityControl()}
				<Select
					label="Priority"
					name="value"
					options={PRIORITY_OPTIONS}
					value={data.task.priority}
					error={errors.priority}
				/>
			{/snippet}
			{#snippet assigneeControl()}
				<Select
					label="Assignee"
					name="value"
					options={assigneeOptions}
					value={data.task.assigneeId ?? ''}
					error={errors.assigneeId}
				/>
			{/snippet}
			{#snippet dueControl()}
				<TextField
					label="Due date"
					name="value"
					type="date"
					value={data.task.dueOn ?? ''}
					error={errors.dueOn}
				/>
				{#if data.task.dueOn}
					<p class="due-note">
						<Due dueOn={data.task.dueOn} status={data.task.status} today={data.today} />
					</p>
				{/if}
			{/snippet}

			{@render patchForm('status', patched === 'status', statusControl)}
			{@render patchForm('priority', patched === 'priority', priorityControl)}
			{@render patchForm('assigneeId', patched === 'assigneeId', assigneeControl)}
			{@render patchForm('dueOn', patched === 'dueOn', dueControl)}

			{#snippet milestoneControl()}
				<Select
					label="Milestone"
					name="value"
					options={milestoneOptions}
					value={data.task.milestoneId ?? ''}
					error={errors.milestoneId}
				/>
				{#if data.task.milestoneId}
					<a class="milestone-link" href="{base}/milestones/{data.task.milestoneId}"
						>Open milestone</a
					>
				{/if}
			{/snippet}
			{@render patchForm('milestoneId', patched === 'milestoneId', milestoneControl)}
			<TaskLabelsField
				current={data.task.labels}
				labels={data.labels}
				{archived}
				answer={answerFor(form, 'labels')}
				settingsHref="{base}/settings"
				max={data.pmLimits.labels}
			/>
		{/if}

		<dl class="facts">
			<dt>Created</dt>
			<dd>
				<LocalTime at={data.task.createdAt} withTime /> by {data.task.createdByName ??
					'a former user'}
			</dd>
			<dt>Updated</dt>
			<dd><LocalTime at={data.task.updatedAt} withTime /></dd>
			{#if data.task.completedAt}
				<dt>Completed</dt>
				<dd><LocalTime at={data.task.completedAt} withTime /></dd>
			{/if}
		</dl>

		<!-- RB-09:reminders -->
		<ReminderPanel
			panel={data.reminders}
			result={form && 'reminder' in form ? form.reminder : null}
			zone={data.clock.zone}
			zoneLabel={data.clock.zoneLabel}
			today={data.clock.today}
		/>

		{#if data.canDelete && !archived}
			<form
				method="POST"
				action="?/delete"
				class="danger"
				use:enhance={() => {
					deleting = true;
					return async ({ update }) => {
						await update();
						deleting = false;
					};
				}}
			>
				<h2>Delete task</h2>
				<p>The task disappears from the project; its number is not reused.</p>
				<label class="confirm"
					><input type="checkbox" name="confirm" value="yes" required /> Yes, delete {data.ref}</label
				>
				<Banner tone="error" message={form && 'deleteError' in form ? form.deleteError : null} />
				<Button type="submit" variant="danger" loading={deleting} loadingLabel="Deleting…"
					>Delete task</Button
				>
			</form>
		{/if}
	</aside>
</div>

<!-- RB-03:comments -->
<CommentThread thread={data.comments} />

<style>
	.task-header {
		display: grid;
		gap: 8px;
		margin-bottom: 16px;
	}
	h1 {
		margin: 0;
		font-size: 22px;
		line-height: 1.3;
		font-weight: 600;
		letter-spacing: -0.015em;
	}
	.ref {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 0.75em;
		font-weight: 500;
		white-space: nowrap;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}
	.banners {
		display: grid;
		gap: 8px;
		margin-bottom: 8px;
	}
	.layout {
		display: grid;
		gap: 20px;
		grid-template-columns: minmax(0, 1fr);
	}
	@media (min-width: 900px) {
		.layout {
			grid-template-columns: minmax(0, 1fr) 280px;
			align-items: start;
		}
		/* RB-08: the checklist sits under the description; the fields span both rows (extra height goes below). */
		.layout {
			grid-template-rows: auto 1fr;
		}
		.main,
		.steps {
			grid-column: 1;
		}
		.fields {
			grid-column: 2;
			grid-row: 1 / span 2;
		}
	}
	.steps {
		min-width: 0;
	}
	.milestone-link {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		color: var(--accent);
		font-size: 13px;
	}
	@media (pointer: coarse) {
		.milestone-link {
			min-height: 44px;
		}
	}
	.chip-list {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.main {
		min-width: 0;
		padding: 18px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	@media (max-width: 420px) {
		.main {
			padding: 14px;
		}
	}
	.desc-footer {
		display: flex;
		gap: 8px;
		margin-top: 16px;
	}
	.edit {
		display: grid;
		gap: 14px;
	}
	.row-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.fields {
		display: grid;
		gap: 14px;
		min-width: 0;
	}
	.patch {
		display: grid;
		gap: 4px;
	}
	.state {
		min-height: 16px;
		margin: 0;
		color: var(--success);
		font-size: 12px;
	}
	.due-note {
		margin: 0;
	}
	dl {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 8px 12px;
		margin: 0;
		font-size: 13px;
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		min-width: 0;
	}
	.facts {
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}
	.danger {
		display: grid;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
	}
	.danger h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--danger);
	}
	.danger p {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
	.confirm {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		font-size: 14px;
	}
	.confirm input {
		width: 18px;
		height: 18px;
		accent-color: var(--danger);
	}
	.conflict {
		display: grid;
		gap: 10px;
		margin-bottom: 16px;
		padding: 16px;
		border: 1px solid var(--warning);
		border-radius: var(--radius-l);
		background: var(--warning-soft);
	}
	.conflict h2 {
		margin: 0;
		font-size: 16px;
	}
	.conflict > p {
		margin: 0;
		font-size: 14px;
	}
	.diff {
		display: grid;
		gap: 10px;
	}
	.diff h3 {
		margin: 0 0 4px;
		font-size: 13px;
	}
	.sides {
		display: grid;
		gap: 8px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
	}
	.side-label {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}
	.value {
		margin: 0;
		padding: 8px;
		border-radius: var(--radius-m);
		background: var(--surface);
		font-size: 13px;
		white-space: pre-wrap;
	}
	.value.long {
		max-height: 220px;
		overflow: auto;
	}
	.conflict-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
