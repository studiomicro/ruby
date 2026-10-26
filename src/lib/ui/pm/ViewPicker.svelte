<!--
	ViewPicker: the user's own saved views of this project (RB-08) and a form that saves the current filters under a
	name. A view opens through its own URL (the server checks the owner); the stored filters are only what the server
	canonicalised. Plain forms: works without JavaScript. RB-12: also the Issues page's views (`kind="issues"`, its own
	action names).
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';
	import type { PmAnswer } from './answer';

	let {
		base,
		kind,
		query,
		views,
		archived,
		answer,
		actionFor,
		saveAction = 'viewSave',
		deleteAction = 'viewDelete'
	}: {
		base: string;
		kind: 'list' | 'board' | 'issues';
		/** The current URL query (the server keeps only the filter keys). */
		query: string;
		views: readonly { id: string; name: string; kind: string }[];
		archived: boolean;
		answer: PmAnswer | null;
		/** The action URL that keeps the current view (`?…&/viewSave`). */
		actionFor: (action: string) => string;
		saveAction?: string;
		deleteAction?: string;
	} = $props();

	let saving = $state(false);
	let deleting = $state<string | null>(null);
	/** Open again after a no-JS answer so the message is in view. */
	const open = $derived(answer !== null);
</script>

<details class="picker" {open}>
	<summary
		>Saved views{#if views.length > 0}<span class="count"> ({views.length})</span>{/if}</summary
	>
	<div class="body">
		<Banner tone={answer?.ok ? 'success' : 'error'} message={answer?.message} />
		{#if views.length === 0}
			<p class="empty">No saved views</p>
		{:else}
			<ul class="list">
				{#each views as v (v.id)}
					<li>
						<a href="{base}/views/{v.id}" class="open"
							><span class="name">{v.name}</span>{#if v.kind !== 'issues'}<span class="kind"
									>{v.kind === 'board' ? 'Board' : 'List'}</span
								>{/if}</a
						>
						{#if !archived}
							<form
								method="POST"
								action={actionFor(deleteAction)}
								use:enhance={() => {
									deleting = v.id;
									return async ({ update }) => {
										await update();
										deleting = null;
									};
								}}
							>
								<input type="hidden" name="id" value={v.id} />
								<Button type="submit" size="sm" variant="ghost" loading={deleting === v.id}
									>Delete<span class="sr-only"> view {v.name}</span></Button
								>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if !archived}
			<form
				method="POST"
				action={actionFor(saveAction)}
				class="save"
				use:enhance={() => {
					saving = true;
					return async ({ update }) => {
						await update();
						saving = false;
					};
				}}
			>
				<input type="hidden" name="kind" value={kind} />
				<input type="hidden" name="query" value={query} />
				<TextField
					label="Save current filters as"
					name="name"
					maxlength={40}
					required
					value={answer && !answer.ok ? (answer.values?.name ?? '') : ''}
					error={answer && !answer.ok ? answer.errors?.name : undefined}
				/>
				<div><Button type="submit" loading={saving} loadingLabel="Saving…">Save view</Button></div>
			</form>
		{/if}
	</div>
</details>

<style>
	.picker {
		margin-bottom: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		padding: 0 14px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
	}
	.count {
		color: var(--muted);
	}
	.body {
		display: grid;
		gap: 12px;
		padding: 4px 14px 14px;
	}
	.empty {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.list {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}
	.open {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		min-height: 36px;
		color: var(--fg);
		text-decoration: none;
	}
	@media (pointer: coarse) {
		.open {
			min-height: 44px;
		}
	}
	.open:hover .name {
		text-decoration: underline;
	}
	.name {
		overflow-wrap: anywhere;
	}
	.kind {
		color: var(--muted);
		font-size: 12px;
	}
	.save {
		display: grid;
		gap: 8px;
	}
</style>
