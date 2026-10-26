<!--
	TaskChecklist: a task's steps (RB-08). Every step has its own small forms (tick, edit, move up/down, delete) that
	post to the task page's actions, so all of it works without JavaScript; with JavaScript they submit in place.
	Ticking never changes the task's version, so an open edit form elsewhere never goes stale. Read-only when the
	project is archived.
-->
<script lang="ts">
	import { flip } from 'svelte/animate';
	import { flipParams, leave, rise } from '#lib/ui/motion';
	import { enhance } from '#lib/ui/pwa/offline-form';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import type { PmAnswer } from './answer';

	type Item = { id: string; text: string; done: boolean; updatedAt: number };
	let {
		items,
		archived,
		answer,
		max
	}: { items: readonly Item[]; archived: boolean; answer: PmAnswer | null; max: number } = $props();

	const done = $derived(items.filter((i) => i.done).length);
	let busy = $state<string | null>(null);

	const submitting = (key: string) => () => {
		busy = key;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: key === 'add' });
			busy = null;
		};
	};
	const errorFor = (id?: string) =>
		answer && !answer.ok && (id === undefined ? !answer.id : answer.id === id) ? answer : null;
</script>

<section class="checklist" aria-labelledby="checklist-heading">
	<header class="head">
		<h2 id="checklist-heading">Checklist</h2>
		{#if items.length > 0}
			<span class="count">{done}/{items.length}<span class="sr-only"> steps done</span></span>
		{/if}
	</header>
	{#if items.length > 0}
		<progress class="bar" value={done} max={items.length} aria-label="Steps done"></progress>
	{/if}
	<p class="sr-only" aria-live="polite">{answer?.ok ? answer.message : ''}</p>

	{#if items.length === 0}
		<p class="empty">No steps</p>
	{:else}
		<ol class="items">
			{#each items as item, i (item.id)}
				<!-- RB-20 Part B: a step added or removed after load slides in or fades out; moves glide. -->
				<li
					class="item"
					class:done={item.done}
					in:rise|local
					out:leave|local={{ instant: true }}
					animate:flip={flipParams(items.length)}
				>
					<div class="row">
						{#if archived}
							<span class="box" aria-hidden="true">{item.done ? '☑' : '☐'}</span>
						{:else}
							<form method="POST" action="?/checkToggle" use:enhance={submitting(`t-${item.id}`)}>
								<input type="hidden" name="id" value={item.id} />
								<input type="hidden" name="done" value={item.done ? '0' : '1'} />
								<button
									type="submit"
									class="tick"
									aria-pressed={item.done}
									aria-label="{item.done ? 'Done' : 'Not done'}: {item.text}"
									disabled={busy === `t-${item.id}`}
									><span class="box" aria-hidden="true">{item.done ? '☑' : '☐'}</span></button
								>
							</form>
						{/if}
						<span class="text">{item.text}</span>
						{#if !archived}
							<details class="more" open={errorFor(item.id) !== null}>
								<summary>Edit<span class="sr-only"> step {i + 1}</span></summary>
								<div class="tools">
									<form
										method="POST"
										action="?/checkEdit"
										class="edit"
										use:enhance={submitting(`e-${item.id}`)}
									>
										<input type="hidden" name="id" value={item.id} />
										<input type="hidden" name="expectedUpdatedAt" value={item.updatedAt} />
										<TextField
											label="Step {i + 1}"
											name="text"
											maxlength={200}
											required
											value={errorFor(item.id)?.values?.text ?? item.text}
											error={errorFor(item.id)?.errors?.text}
										/>
										<Banner tone="error" message={errorFor(item.id)?.message} />
										<div class="buttons">
											<Button type="submit" size="sm" loading={busy === `e-${item.id}`}>Save</Button
											>
										</div>
									</form>
									<div class="buttons">
										{#each [{ dir: 'up', label: 'Move up', off: i === 0 }, { dir: 'down', label: 'Move down', off: i === items.length - 1 }] as m (m.dir)}
											<form
												method="POST"
												action="?/checkMove"
												use:enhance={submitting(`m-${item.id}`)}
											>
												<input type="hidden" name="id" value={item.id} />
												<input type="hidden" name="direction" value={m.dir} />
												<Button type="submit" size="sm" variant="ghost" disabled={m.off}
													>{m.label}</Button
												>
											</form>
										{/each}
										<form
											method="POST"
											action="?/checkDelete"
											use:enhance={submitting(`d-${item.id}`)}
										>
											<input type="hidden" name="id" value={item.id} />
											<Button
												type="submit"
												size="sm"
												variant="danger"
												loading={busy === `d-${item.id}`}>Delete</Button
											>
										</form>
									</div>
								</div>
							</details>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
	{/if}

	{#if !archived}
		{#if items.length >= max}
			<p class="limit">A task can have up to {max} steps.</p>
		{:else}
			<form method="POST" action="?/checkAdd" class="add" use:enhance={submitting('add')}>
				<TextField
					label="New step"
					name="text"
					maxlength={200}
					required
					value={errorFor()?.values?.text ?? ''}
					error={errorFor()?.errors?.text}
				/>
				<Banner
					tone="error"
					message={errorFor() && !errorFor()?.errors ? errorFor()?.message : null}
				/>
				<div class="buttons">
					<Button type="submit" size="sm" loading={busy === 'add'} loadingLabel="Adding…"
						>Add step</Button
					>
				</div>
			</form>
		{/if}
	{/if}
</section>

<style>
	.checklist {
		display: grid;
		gap: 10px;
		min-width: 0;
		padding: 18px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	@media (max-width: 420px) {
		.checklist {
			padding: 14px;
		}
	}
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.count {
		color: var(--muted);
		font-size: 13px;
		font-variant-numeric: tabular-nums;
	}
	.bar {
		width: 100%;
		height: 6px;
		border: 0;
		border-radius: 999px;
		background: var(--surface-3);
		overflow: hidden;
		appearance: none;
	}
	.bar::-webkit-progress-bar {
		background: var(--surface-3);
	}
	.bar::-webkit-progress-value {
		background: var(--success);
	}
	.bar::-moz-progress-bar {
		background: var(--success);
	}
	.empty,
	.limit {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.items {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.item + .item {
		border-top: 1px solid var(--border);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		padding: 2px 0;
		min-width: 0;
	}
	.tick {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border: 0;
		border-radius: var(--radius-s);
		background: none;
		color: var(--fg);
		cursor: pointer;
	}
	.tick:hover {
		background: var(--surface-2);
	}
	@media (pointer: coarse) {
		.tick {
			width: 44px;
			height: 44px;
		}
	}
	.box {
		font-size: 18px;
		line-height: 1;
	}
	.done .box {
		color: var(--success);
	}
	.text {
		flex: 1 1 0;
		min-width: 0;
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.done .text {
		color: var(--muted);
		text-decoration: line-through;
	}
	.more {
		margin-left: auto;
	}
	.more[open] {
		flex: 1 0 100%;
		margin-left: 0;
	}
	.more summary {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		padding: 0 6px;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.more summary {
			min-height: 44px;
		}
	}
	.tools {
		display: grid;
		gap: 8px;
		padding: 4px 0 10px;
	}
	.edit,
	.add {
		display: grid;
		gap: 8px;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
</style>
