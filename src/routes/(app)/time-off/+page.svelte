<script lang="ts">
	import { enhance } from '$app/forms';
	import { HALF_DAY_LABELS, HALF_DAY_PARTS } from '#lib/shared/enums';
	import BalanceCards from '#lib/ui/time-off/BalanceCards.svelte';
	import RequestList from '#lib/ui/time-off/RequestList.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextArea from '#lib/ui/kit/TextArea.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data, form } = $props();
	const f = $derived((form ?? {}) as Record<string, unknown>);
	const errors = $derived((f.errors ?? {}) as Record<string, string | undefined>);
	const echoed = $derived((f.values ?? null) as Record<string, string> | null);

	// The form's fields: the server's echo after a refused or previewed submit, else empty (a success clears them).
	// Overridable deriveds, so a no-JS render shows the echo too; typing updates them through the form's oninput.
	let typeId = $derived(echoed?.typeId ?? '');
	let startOn = $derived(echoed?.startOn ?? '');
	let endOn = $derived(echoed?.endOn ?? '');
	const halfDay = $derived(echoed?.halfDay ?? 'none');
	const reason = $derived(echoed?.reason ?? '');
	function track(event: Event) {
		const el = event.target as HTMLInputElement | HTMLSelectElement;
		if (el.name === 'typeId') typeId = el.value;
		else if (el.name === 'startOn') startOn = el.value;
		else if (el.name === 'endOn') endOn = el.value;
	}
	const singleDay = $derived(!endOn || endOn === startOn);
	const requiresReason = $derived(
		data.linked ? (data.types.find((t) => t.id === typeId)?.requiresReason ?? false) : false
	);
	const typeOptions = $derived(
		data.linked
			? [
					{ value: '', label: 'Choose a type' },
					...data.types.map((t) => ({ value: t.id, label: t.name }))
				]
			: []
	);
	const halfDayOptions = HALF_DAY_PARTS.map((p) => ({ value: p, label: HALF_DAY_LABELS[p] }));
	let sending = $state<string | null>(null);
</script>

<PageHeader title="Time off" description="Your leave balances and requests." />

{#if !data.linked}
	<EmptyState
		title="Your account is not linked to an employee record. Ask HR."
		description="You can still see who is out on the team calendar."
		action={{ href: '/time-off/calendar', label: 'Open the calendar' }}
	/>
{:else}
	<div class="stack">
		<Banner tone="error" message={f.error as string | undefined} />
		<Banner tone="success" message={(f.requested ?? f.canceled) as string | undefined} />
		{#if data.selfApproval}
			<Banner tone="warning">
				No one else can approve your requests yet; you can approve them yourself (logged).
				<a href="/time-off/approvals">Open approvals</a>
			</Banner>
		{/if}

		<section aria-labelledby="balances-h">
			<h2 id="balances-h">Balances</h2>
			{#if data.balances.length === 0}
				<EmptyState
					title="No leave with a yearly balance"
					description="Leave you request is recorded without a balance."
				/>
			{:else}
				<BalanceCards balances={data.balances} period={data.period} />
			{/if}
			<p class="note">{data.note}</p>
		</section>

		<section aria-labelledby="request-h" class="card">
			<h2 id="request-h">Request leave</h2>
			{#if data.types.length === 0}
				<p class="muted">No leave types are available. Ask HR.</p>
			{:else}
				<form
					method="POST"
					action="?/request"
					class="request-form"
					oninput={track}
					use:enhance={({ submitter }) => {
						const kind =
							submitter?.getAttribute('formaction') === '?/preview' ? 'preview' : 'request';
						sending = kind;
						return async ({ result, update }) => {
							const done = result.type === 'success' && kind === 'request';
							await update({ reset: done });
							if (done) {
								typeId = '';
								startOn = '';
								endOn = '';
							}
							sending = null;
						};
					}}
				>
					<Select
						label="Leave type"
						name="typeId"
						options={typeOptions}
						value={typeId}
						error={errors.typeId}
						required
					/>
					<div class="dates">
						<TextField
							label="Start date"
							name="startOn"
							type="date"
							value={startOn}
							error={errors.startOn}
							required
						/>
						<TextField
							label="End date"
							name="endOn"
							type="date"
							value={endOn}
							error={errors.endOn}
							hint="Leave empty for a single day."
						/>
					</div>
					{#if singleDay}
						<Select
							label="Part of the day"
							name="halfDay"
							options={halfDayOptions}
							value={halfDay}
							error={errors.halfDay}
						/>
					{:else}
						<input type="hidden" name="halfDay" value="none" />
					{/if}
					<TextArea
						label={requiresReason ? 'Reason (required for this type)' : 'Reason (optional)'}
						name="reason"
						rows={3}
						maxlength={500}
						value={reason}
						error={errors.reason}
					/>
					{#if f.preview}
						<p class="preview" role="status">{f.preview}</p>
					{/if}
					<div class="actions">
						<Button
							type="submit"
							formaction="?/preview"
							loading={sending === 'preview'}
							loadingLabel="Counting…"
						>
							Count days
						</Button>
						<Button
							type="submit"
							variant="primary"
							loading={sending === 'request'}
							loadingLabel="Sending…">Submit request</Button
						>
					</div>
				</form>
			{/if}
		</section>

		<section aria-labelledby="mine-h">
			<h2 id="mine-h">My requests</h2>
			{#if data.requests.length === 0}
				<EmptyState title="No requests yet" description="Requests you submit show up here." />
			{:else}
				<RequestList requests={data.requests} cancelAction="?/cancel" label="My requests" />
			{/if}
		</section>
	</div>
{/if}

<style>
	.stack {
		display: grid;
		gap: 22px;
		min-width: 0;
	}
	h2 {
		margin: 0 0 10px;
		font-size: 16px;
		font-weight: 600;
	}
	.card {
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.request-form {
		display: grid;
		gap: 12px;
		max-width: 560px;
	}
	.dates {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
	}
	@media (min-width: 520px) {
		.dates {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.note,
	.muted {
		margin: 8px 0 0;
		color: var(--muted);
		font-size: 13px;
	}
	.preview {
		margin: 0;
		padding: 8px 10px;
		border-radius: var(--radius-m);
		background: var(--surface-2);
		font-size: 14px;
	}
</style>
