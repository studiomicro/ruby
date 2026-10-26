<!--
	RequestList: leave requests as a list of cards (no table, so a phone never scrolls sideways). Shows type, dates,
	days, status, the decision and its note; `cancelAction` adds a Cancel button to requests marked `cancelable`.
	Every text is plain text (never {@html}).
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		HALF_DAY_LABELS,
		LEAVE_STATUS_LABELS,
		type HalfDayPart,
		type LeaveStatus
	} from '#lib/shared/enums';
	import { daysLabel, rangeLabel } from '#lib/shared/time-off';
	import Button from '#lib/ui/kit/Button.svelte';

	interface Item {
		id: string;
		employeeName?: string;
		typeName: string;
		startOn: string;
		endOn: string;
		halfDay: HalfDayPart;
		halfDays: number;
		reason: string;
		status: LeaveStatus;
		decidedByName: string | null;
		decisionNote: string;
		/** Approved by the requester while nobody else could (audited). */
		selfApproved?: boolean;
		updatedAt: number;
		cancelable: boolean;
	}

	let {
		requests,
		cancelAction,
		label
	}: { requests: readonly Item[]; cancelAction?: string; label: string } = $props();
	let canceling = $state<string | null>(null);
</script>

<ul class="requests" aria-label={label}>
	{#each requests as r (r.id)}
		<li class="request">
			<div class="top">
				<span class="what">
					{#if r.employeeName}<strong>{r.employeeName}</strong> ·
					{/if}{r.typeName}
				</span>
				<span class="status {r.status}">{LEAVE_STATUS_LABELS[r.status]}</span>
			</div>
			<div class="when">
				{rangeLabel(r.startOn, r.endOn)}{#if r.halfDay !== 'none'}
					· {HALF_DAY_LABELS[r.halfDay]}{/if} · {daysLabel(r.halfDays)}
			</div>
			{#if r.reason}<p class="reason">{r.reason}</p>{/if}
			{#if r.selfApproved && r.status === 'approved'}
				<p class="decision">
					<span class="self">Self-approved</span> by {r.decidedByName ??
						'the requester'}{#if r.decisionNote}:
						{r.decisionNote}{/if}
				</p>
			{:else if r.decidedByName && (r.status === 'approved' || r.status === 'rejected')}
				<p class="decision">
					{r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.decidedByName}{#if r.decisionNote}:
						{r.decisionNote}{/if}
				</p>
			{:else if r.decisionNote}
				<p class="decision">{r.decisionNote}</p>
			{/if}
			{#if cancelAction && r.cancelable}
				<form
					method="POST"
					action={cancelAction}
					use:enhance={() => {
						canceling = r.id;
						return async ({ update }) => {
							await update();
							canceling = null;
						};
					}}
				>
					<input type="hidden" name="id" value={r.id} />
					<input type="hidden" name="expected" value={r.updatedAt} />
					<Button type="submit" size="sm" variant="danger" loading={canceling === r.id}>
						Cancel request
					</Button>
				</form>
			{/if}
		</li>
	{/each}
</ul>

<style>
	.requests {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.request {
		display: grid;
		gap: 4px;
		padding: 12px 14px;
		font-size: 14px;
		min-width: 0;
	}
	.request + .request {
		border-top: 1px solid var(--border);
	}
	.top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 6px 10px;
	}
	.what {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.when,
	.decision {
		color: var(--muted);
		font-size: 13px;
	}
	.reason,
	.decision {
		margin: 0;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.status {
		padding: 1px 8px;
		border-radius: 999px;
		background: var(--surface-2);
		font-size: 12px;
		font-weight: 500;
	}
	.status.approved {
		background: var(--success-soft);
		color: var(--success);
	}
	.status.rejected {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.status.pending {
		background: var(--warning-soft);
		color: var(--warning);
	}
	form {
		margin-top: 4px;
	}
	.self {
		padding: 0 6px;
		border-radius: 999px;
		background: var(--warning-soft);
		color: var(--warning);
		font-weight: 600;
	}
</style>
