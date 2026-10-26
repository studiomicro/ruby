<script lang="ts">
	import { enhance } from '$app/forms';
	import WorkFields from '#lib/ui/hr/WorkFields.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import FieldError from '#lib/ui/kit/FieldError.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextArea from '#lib/ui/kit/TextArea.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data, form } = $props();
	const e = $derived(data.employee);
	const f = $derived((form ?? {}) as Record<string, unknown>);
	const section = $derived((f.section as string | undefined) ?? null);
	const errorsFor = (s: string) =>
		(section === s ? (f.errors ?? {}) : {}) as Record<string, string | undefined>;
	const savedFor = (s: string) =>
		section === s ? ((f.saved as string | undefined) ?? null) : null;
	const valuesFor = (s: string) =>
		(section === s ? (f.values ?? null) : null) as Record<string, string | null> | null;
	const workValues = $derived(valuesFor('work') ?? (e as unknown as Record<string, string | null>));
	const deleted = $derived(e.deletedAt !== null);
	const userOptions = $derived([
		{ value: '', label: 'Choose an account' },
		...data.users.map((u) => ({ value: u.id, label: u.name }))
	]);
	let saving = $state<string | null>(null);
	const saveWith = (name: string) => () => {
		saving = name;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			saving = null;
		};
	};
	/** Sensitive inputs are cleared after a confirmed save (the values are never shown again). */
	const saveSensitive = () => {
		saving = 'sensitive';
		return async ({
			result,
			update
		}: {
			result: { type: string };
			update: (o?: { reset?: boolean }) => Promise<void>;
		}) => {
			await update({ reset: result.type === 'success' });
			saving = null;
		};
	};
	const INPUT_KIND: Record<
		string,
		{ type?: 'text' | 'email' | 'date'; inputmode?: 'numeric' | 'tel' }
	> = {
		birth_date: { type: 'date' },
		personal_email: { type: 'email' },
		personal_phone: { inputmode: 'tel' },
		nik: { inputmode: 'numeric' },
		npwp: { inputmode: 'numeric' },
		bpjs_kes: { inputmode: 'numeric' },
		bpjs_tk: { inputmode: 'numeric' },
		bank_account: { inputmode: 'numeric' }
	};
</script>

<PageHeader
	title="Edit {e.fullName}"
	description="HR only. Every change is recorded in the audit log."
>
	{#snippet actions()}
		<Button href="/people/{e.id}" variant="ghost">View profile</Button>
	{/snippet}
</PageHeader>

<div class="sections">
	{#if deleted}
		<Banner tone="warning" message="This employee record is deleted. Restore it to edit it." />
	{/if}

	{#if !deleted}
		<form
			method="POST"
			action="?/updateWork"
			class="panel form"
			use:enhance={saveWith('work')}
			aria-label="Work and employment"
		>
			<Banner tone="success" message={savedFor('work')} />
			<Banner tone="error" message={errorsFor('work').form} />
			<input type="hidden" name="expectedUpdatedAt" value={e.updatedAt} />
			<WorkFields values={workValues} errors={errorsFor('work')} managers={data.managers} />
			<div>
				<Button type="submit" variant="primary" loading={saving === 'work'} loadingLabel="Saving…"
					>Save work and employment</Button
				>
			</div>
		</form>

		<form
			method="POST"
			action="?/updateSensitive"
			class="panel form"
			use:enhance={saveSensitive}
			autocomplete="off"
			aria-labelledby="h-sensitive"
		>
			<h2 id="h-sensitive">Personal and sensitive</h2>
			<p class="hint">
				Stored encrypted. Current values are never shown here: leave a field empty to keep it, or
				tick Remove to clear it. Reveal values on the profile (audited).
			</p>
			{#if !data.keyReady}
				<Banner
					tone="warning"
					message="Sensitive data storage is not configured. Nothing sensitive can be saved."
				/>
			{/if}
			<Banner tone="success" message={savedFor('sensitive')} />
			<Banner tone="error" message={errorsFor('sensitive').form} />
			<input type="hidden" name="expectedUpdatedAt" value={data.personal.updatedAt} />
			<div class="grid">
				{#each data.personal.fields as item (item.field)}
					<div class="sensitive">
						{#if item.field === 'home_address'}
							<TextArea
								label={item.label}
								name={item.field}
								rows={3}
								maxlength={500}
								hint="Stored: {item.masked}"
								error={errorsFor('sensitive')[item.field]}
								disabled={!data.keyReady}
							/>
						{:else}
							<TextField
								label={item.label}
								name={item.field}
								type={INPUT_KIND[item.field]?.type ?? 'text'}
								inputmode={INPUT_KIND[item.field]?.inputmode}
								hint="Stored: {item.masked}"
								error={errorsFor('sensitive')[item.field]}
								disabled={!data.keyReady}
								autocomplete="off"
							/>
						{/if}
						{#if item.set}
							<label class="check"
								><input
									type="checkbox"
									name="clear_{item.field}"
									disabled={!data.keyReady}
								/>Remove</label
							>
						{/if}
					</div>
				{/each}
				<div class="sensitive">
					<TextField
						label="Bank name"
						name="bank_name"
						maxlength={60}
						hint="Stored: {data.personal.bankName ?? 'Not set'}"
						error={errorsFor('sensitive').bank_name}
						disabled={!data.keyReady}
					/>
					{#if data.personal.bankName}
						<label class="check"
							><input
								type="checkbox"
								name="clear_bank_name"
								disabled={!data.keyReady}
							/>Remove</label
						>
					{/if}
				</div>
			</div>
			<div>
				<Button
					type="submit"
					variant="primary"
					disabled={!data.keyReady}
					loading={saving === 'sensitive'}
					loadingLabel="Saving…">Save sensitive details</Button
				>
			</div>
		</form>

		<form
			method="POST"
			action="?/addCompensation"
			class="panel form"
			use:enhance={saveSensitive}
			autocomplete="off"
			aria-labelledby="h-salary"
		>
			<h2 id="h-salary">Add a salary record</h2>
			<p class="hint">
				HR only, encrypted, never in lists or exports. Records cannot be changed: add a newer one to
				correct a value.
			</p>
			{#if !data.keyReady}
				<Banner tone="warning" message="Sensitive data storage is not configured." />
			{/if}
			<Banner tone="success" message={savedFor('salary')} />
			<Banner tone="error" message={errorsFor('salary').form} />
			<div class="grid">
				<TextField
					label="Effective from"
					name="effectiveOn"
					type="date"
					required
					value={valuesFor('salary')?.effectiveOn ?? ''}
					error={errorsFor('salary').effectiveOn}
					disabled={!data.keyReady}
				/>
				<TextField
					label="Monthly amount (Rp)"
					name="amount"
					inputmode="numeric"
					required
					error={errorsFor('salary').amount}
					disabled={!data.keyReady}
				/>
				<TextField
					label="Note"
					name="note"
					maxlength={200}
					error={errorsFor('salary').note}
					disabled={!data.keyReady}
				/>
			</div>
			<div>
				<Button
					type="submit"
					disabled={!data.keyReady}
					loading={saving === 'salary'}
					loadingLabel="Adding…">Add salary record</Button
				>
			</div>
		</form>

		<section class="panel form" aria-labelledby="h-account">
			<h2 id="h-account">Linked account</h2>
			<Banner tone="success" message={savedFor('account')} />
			<Banner tone="error" message={errorsFor('account').form} />
			{#if e.userId}
				<p>
					Linked to <strong>{e.linkedUserName ?? 'an account'}</strong
					>{#if e.linkedUserStatus === 'disabled'}
						(disabled){/if}.
				</p>
				<form method="POST" action="?/unlinkUser" use:enhance={saveWith('unlink')}>
					<input type="hidden" name="expectedUpdatedAt" value={e.updatedAt} />
					<Button type="submit" loading={saving === 'unlink'}>Unlink account</Button>
				</form>
			{:else}
				<form method="POST" action="?/linkUser" class="form" use:enhance={saveWith('link')}>
					<input type="hidden" name="expectedUpdatedAt" value={e.updatedAt} />
					<Select
						label="Account"
						name="userId"
						options={userOptions}
						error={errorsFor('account').userId}
						hint="Only active accounts not linked to another employee."
					/>
					<div>
						<Button type="submit" loading={saving === 'link'}>Link account</Button>
					</div>
				</form>
			{/if}
		</section>

		<section class="panel form" aria-labelledby="h-status">
			<h2 id="h-status">{e.status === 'active' ? 'Terminate employment' : 'Former employee'}</h2>
			<Banner tone="success" message={savedFor('status')} />
			<Banner tone="error" message={errorsFor('status').form} />
			{#if e.status === 'active'}
				<form method="POST" action="?/terminate" class="form" use:enhance={saveWith('terminate')}>
					<input type="hidden" name="expectedUpdatedAt" value={e.updatedAt} />
					<TextField
						label="Last working day"
						name="endOn"
						type="date"
						required
						value={valuesFor('status')?.endOn ?? data.today}
						error={errorsFor('status').endOn}
					/>
					<label class="check"
						><input type="checkbox" name="confirm" required />The employee leaves the directory and
						the org chart.</label
					>
					<FieldError id="terminate-confirm" message={errorsFor('status').confirm} />
					<div>
						<Button type="submit" variant="danger" loading={saving === 'terminate'}
							>Terminate</Button
						>
					</div>
				</form>
			{:else}
				<p>Employment ended on {e.endOn ?? '—'}.</p>
				<form method="POST" action="?/reinstate" use:enhance={saveWith('reinstate')}>
					<input type="hidden" name="expectedUpdatedAt" value={e.updatedAt} />
					<Button type="submit" loading={saving === 'reinstate'}>Reinstate</Button>
				</form>
			{/if}
		</section>
	{/if}

	<section class="panel form" aria-labelledby="h-delete">
		<h2 id="h-delete">{deleted ? 'Restore employee record' : 'Delete employee record'}</h2>
		<Banner tone="success" message={savedFor('delete')} />
		<Banner tone="error" message={errorsFor('delete').form} />
		{#if deleted}
			<form method="POST" action="?/restore" use:enhance={saveWith('restore')}>
				<input type="hidden" name="expectedUpdatedAt" value={e.updatedAt} />
				<Button type="submit" variant="primary" loading={saving === 'restore'}>Restore</Button>
			</form>
		{:else}
			<p class="hint">
				For records created by mistake. The record is kept and can be restored; use Terminate for
				people who leave.
			</p>
			<form method="POST" action="?/delete" class="form" use:enhance={saveWith('delete')}>
				<input type="hidden" name="expectedUpdatedAt" value={e.updatedAt} />
				<label class="check"
					><input type="checkbox" name="confirm" required />Delete this employee record.</label
				>
				<FieldError id="delete-confirm" message={errorsFor('delete').confirm} />
				<div>
					<Button type="submit" variant="danger" loading={saving === 'delete'}>Delete</Button>
				</div>
			</form>
		{/if}
	</section>
</div>

<style>
	.sections {
		display: grid;
		gap: 16px;
		max-width: 820px;
	}
	.panel {
		min-width: 0;
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
	.form {
		display: grid;
		gap: 14px;
		min-width: 0;
	}
	h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
	}
	p {
		margin: 0;
	}
	.hint {
		color: var(--muted);
		font-size: 13px;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
	}
	@media (min-width: 640px) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.sensitive {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		font-size: 14px;
	}
	.check input {
		width: 20px;
		height: 20px;
		margin: 0;
		flex: none;
	}
</style>
