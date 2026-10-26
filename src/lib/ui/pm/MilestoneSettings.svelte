<!--
	MilestoneSettings: a project's milestones in Settings (RB-08): create, edit, close or reopen, delete (deleting
	unlinks its tasks). Managing is for the lead, the creator or an admin; everyone sees the list.
-->
<script lang="ts">
	import { enhance } from '#lib/ui/pwa/offline-form';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import TextArea from '#lib/ui/kit/TextArea.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import { formatDue } from '#lib/ui/tasks/options';
	import type { PmAnswer } from './answer';

	type Milestone = {
		id: string;
		name: string;
		description: string;
		dueOn: string | null;
		status: 'open' | 'closed';
		updatedAt: number;
	};
	let {
		milestones,
		base,
		today,
		canManage,
		archived,
		answer
	}: {
		milestones: readonly Milestone[];
		base: string;
		today: string;
		canManage: boolean;
		archived: boolean;
		answer: PmAnswer | null;
	} = $props();

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
	const editable = $derived(canManage && !archived);
	const echo = (a: PmAnswer | null, key: string, fallback: string) =>
		a && !a.ok ? (a.values?.[key] ?? fallback) : fallback;
</script>

<section class="panel" aria-labelledby="milestones-heading">
	<h3 id="milestones-heading">Milestones</h3>
	<p class="intro">Group tasks into a delivery with a target date. Up to 50 per project.</p>
	{#if createAnswer}
		<Banner tone={createAnswer.ok ? 'success' : 'error'} message={createAnswer.message} />
	{/if}
	{#if milestones.length === 0}
		<p class="empty">Add your first milestone</p>
	{:else}
		<ul class="rows">
			{#each milestones as m (m.id)}
				{@const a = rowAnswer(m.id)}
				<li>
					<div class="row">
						<a class="name" href="{base}/milestones/{m.id}">{m.name}</a>
						{#if m.dueOn}<span class="due">Due {formatDue(m.dueOn, today)}</span>{/if}
						<Badge tone={m.status === 'open' ? 'accent' : 'neutral'}
							>{m.status === 'open' ? 'Open' : 'Closed'}</Badge
						>
						{#if editable}
							<details class="edit" open={a !== null && !a.ok}>
								<summary>Edit<span class="sr-only"> milestone {m.name}</span></summary>
								<form
									method="POST"
									action="?/milestoneSave"
									class="form"
									use:enhance={submitting(`s-${m.id}`)}
								>
									<input type="hidden" name="id" value={m.id} />
									<input type="hidden" name="expectedUpdatedAt" value={m.updatedAt} />
									<TextField
										label="Name"
										name="name"
										required
										maxlength={80}
										value={echo(a, 'name', m.name)}
										error={a?.errors?.name}
									/>
									<TextArea
										label="Description"
										name="description"
										rows={3}
										maxlength={1000}
										value={echo(a, 'description', m.description)}
										error={a?.errors?.description}
									/>
									<TextField
										label="Due date"
										name="dueOn"
										type="date"
										value={echo(a, 'dueOn', m.dueOn ?? '')}
										error={a?.errors?.dueOn}
									/>
									<div class="buttons">
										<Button type="submit" size="sm" loading={busy === `s-${m.id}`}
											>Save milestone</Button
										>
									</div>
								</form>
								<div class="buttons">
									<form
										method="POST"
										action="?/milestoneStatus"
										use:enhance={submitting(`c-${m.id}`)}
									>
										<input type="hidden" name="id" value={m.id} />
										<input type="hidden" name="expectedUpdatedAt" value={m.updatedAt} />
										<input
											type="hidden"
											name="status"
											value={m.status === 'open' ? 'closed' : 'open'}
										/>
										<Button type="submit" size="sm" loading={busy === `c-${m.id}`}
											>{m.status === 'open' ? 'Close milestone' : 'Reopen milestone'}</Button
										>
									</form>
									<form
										method="POST"
										action="?/milestoneDelete"
										use:enhance={submitting(`d-${m.id}`)}
									>
										<input type="hidden" name="id" value={m.id} />
										<Button type="submit" size="sm" variant="danger" loading={busy === `d-${m.id}`}
											>Delete milestone</Button
										>
									</form>
								</div>
								<p class="note">Deleting removes the milestone from its tasks; the tasks stay.</p>
							</details>
						{/if}
					</div>
					{#if a}<Banner tone={a.ok ? 'success' : 'error'} message={a.message} />{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if editable}
		<form
			method="POST"
			action="?/milestoneSave"
			class="form create"
			use:enhance={submitting('new', true)}
		>
			<h4>New milestone</h4>
			<TextField
				label="Name"
				name="name"
				required
				maxlength={80}
				value={echo(createAnswer, 'name', '')}
				error={createAnswer && !createAnswer.ok ? createAnswer.errors?.name : undefined}
			/>
			<TextField
				label="Due date"
				name="dueOn"
				type="date"
				value={echo(createAnswer, 'dueOn', '')}
				error={createAnswer && !createAnswer.ok ? createAnswer.errors?.dueOn : undefined}
			/>
			<TextArea
				label="Description"
				name="description"
				rows={2}
				maxlength={1000}
				value={echo(createAnswer, 'description', '')}
				error={createAnswer && !createAnswer.ok ? createAnswer.errors?.description : undefined}
			/>
			<div class="buttons">
				<Button type="submit" loading={busy === 'new'} loadingLabel="Adding…">Add milestone</Button>
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
	.empty,
	.note {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.note {
		font-size: 13px;
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
	.name {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		color: var(--fg);
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	@media (pointer: coarse) {
		.name {
			min-height: 44px;
		}
	}
	.due {
		color: var(--muted);
		font-size: 13px;
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
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
