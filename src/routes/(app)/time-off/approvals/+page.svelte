<script lang="ts">
	import { enhance } from '#lib/ui/pwa/offline-form';
	import { HALF_DAY_LABELS } from '#lib/shared/enums';
	import { daysLabel, formatDays, rangeLabel } from '#lib/shared/time-off';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data, form } = $props();
	const f = $derived((form ?? {}) as Record<string, unknown>);
	let sending = $state<string | null>(null);
</script>

<PageHeader title="Approvals" description="Leave requests waiting for your decision." />

<div class="stack">
	<Banner tone="success" message={f.decided as string | undefined} />
	<Banner tone="error" message={f.error as string | undefined} />
	{#if data.selfApproval}
		<Banner
			tone="warning"
			message="No one else can approve your requests yet; you can approve them yourself (logged)."
		/>
	{/if}

	{#if data.queue.length === 0}
		<EmptyState title="Nothing to decide" description="New requests you may decide show up here." />
	{:else}
		<ul class="queue" aria-label="Requests to decide">
			{#each data.queue as r (r.id)}
				<li class="item">
					<div class="head">
						<strong>{r.employeeName}</strong>
						<span class="type">{r.typeName}</span>
						{#if r.own}<span class="own">Your request · self-approval is logged</span>{/if}
					</div>
					<div class="when">
						{rangeLabel(r.startOn, r.endOn)}{#if r.halfDay !== 'none'}
							· {HALF_DAY_LABELS[r.halfDay]}{/if} · {daysLabel(r.halfDays)}
					</div>
					{#if r.remainingAfter !== null}
						<div class:short={r.remainingAfter < 0} class="remaining">
							{r.remainingAfter < 0
								? `Not enough balance: ${formatDays(-r.remainingAfter)} days short`
								: `${formatDays(r.remainingAfter)} days left after approval`}
						</div>
					{/if}
					{#if r.reason}<p class="reason">{r.reason}</p>{/if}
					{#if r.overlaps.length}
						<p class="overlap">Also out: {r.overlaps.join(', ')}</p>
					{/if}
					<form
						method="POST"
						action="?/approve"
						class="decide"
						use:enhance={({ submitter }) => {
							sending = `${r.id}:${submitter?.getAttribute('formaction') === '?/reject' ? 'reject' : 'approve'}`;
							return async ({ update }) => {
								await update();
								sending = null;
							};
						}}
					>
						<input type="hidden" name="id" value={r.id} />
						<input type="hidden" name="expected" value={r.updatedAt} />
						<TextField label="Note (optional)" name="note" maxlength={500} />
						<div class="buttons">
							<Button
								type="submit"
								variant="primary"
								loading={sending === `${r.id}:approve`}
								loadingLabel="Approving…">Approve</Button
							>
							<Button
								type="submit"
								variant="danger"
								formaction="?/reject"
								loading={sending === `${r.id}:reject`}
								loadingLabel="Rejecting…">Reject</Button
							>
						</div>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.stack {
		display: grid;
		gap: 14px;
		min-width: 0;
	}
	.queue {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.item {
		display: grid;
		gap: 4px;
		padding: 12px 14px;
		font-size: 14px;
		min-width: 0;
	}
	.item + .item {
		border-top: 1px solid var(--border);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		align-items: baseline;
	}
	.type,
	.when,
	.remaining {
		color: var(--muted);
		font-size: 13px;
	}
	.own {
		padding: 0 6px;
		border-radius: 999px;
		background: var(--warning-soft);
		color: var(--warning);
		font-size: 12px;
		font-weight: 600;
	}
	.remaining.short {
		color: var(--danger);
	}
	.reason,
	.overlap {
		margin: 0;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.overlap {
		color: var(--warning);
		font-size: 13px;
	}
	.decide {
		display: grid;
		gap: 8px;
		margin-top: 6px;
		max-width: 480px;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
