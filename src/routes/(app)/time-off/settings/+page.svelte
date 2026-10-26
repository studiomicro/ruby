<script lang="ts">
	import { enhance } from '$app/forms';
	import { WEEKDAY_NAMES } from '#lib/shared/time-off';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import FieldError from '#lib/ui/kit/FieldError.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data, form } = $props();
	const f = $derived((form ?? {}) as Record<string, unknown>);
	const section = $derived((f.section as string | undefined) ?? null);
	const errorsFor = (s: string) =>
		(section === s ? (f.errors ?? {}) : {}) as Record<string, string | undefined>;
	const messageFor = (s: string) => ({
		saved: section === s ? ((f.saved as string | undefined) ?? null) : null,
		error: section === s ? ((f.error as string | undefined) ?? null) : null
	});
	let saving = $state<string | null>(null);
	/** Marks `name` as saving; an add form (`clear`) is emptied once the server confirmed the write. */
	const saveWith =
		(name: string, clear = false) =>
		() => {
			saving = name;
			return async ({
				result,
				update
			}: {
				result: { type: string };
				update: (o?: { reset?: boolean }) => Promise<void>;
			}) => {
				await update({ reset: clear && result.type === 'success' });
				saving = null;
			};
		};
	const yearOptions = $derived(data.years.map((y) => ({ value: String(y), label: String(y) })));
	const kindOptions = [
		{ value: 'balance', label: 'Yearly balance' },
		{ value: 'logged', label: 'Logged only (no balance)' }
	];
	const balanceTypes = $derived(data.types.filter((t) => t.kind === 'balance'));
	const employeeOptions = $derived([
		{ value: '', label: 'Choose an employee' },
		...data.employees.map((e) => ({ value: e.id, label: e.fullName }))
	]);
	const adjustTypeOptions = $derived(balanceTypes.map((t) => ({ value: t.id, label: t.name })));
</script>

<PageHeader
	title="Time-off settings"
	description="HR only. Every change is recorded in the audit log."
/>

<div class="sections">
	{#if data.noHolidaysThisYear}
		<Banner tone="warning" message="No holidays entered for {data.thisYear}." />
	{/if}

	<section class="card" aria-labelledby="types-h">
		<h2 id="types-h">Leave types</h2>
		<ul class="rows">
			{#each data.types as t (t.id)}
				{@const key = `type:${t.id}`}
				{@const msg = messageFor(key)}
				{@const errors = errorsFor(key)}
				<li>
					<form
						method="POST"
						action="?year={data.year}&/typeSave"
						class="type-form"
						use:enhance={saveWith(key)}
					>
						<input type="hidden" name="id" value={t.id} />
						<input type="hidden" name="expected" value={t.updatedAt} />
						<TextField
							label="Name"
							name="name"
							value={t.name}
							maxlength={40}
							error={errors.name}
							required
						/>
						{#if t.kind === 'balance'}
							<TextField
								label="Days per year"
								name="annualDays"
								value={t.annualDays}
								inputmode="decimal"
								error={errors.annualDays}
							/>
						{:else}
							<p class="kind">Logged only</p>
						{/if}
						<label class="check"
							><input type="checkbox" name="requiresReason" checked={t.requiresReason} />Reason
							required</label
						>
						<label class="check"
							><input type="checkbox" name="active" checked={t.active} />Active</label
						>
						<Button type="submit" size="sm" loading={saving === key} loadingLabel="Saving…"
							>Save {t.name}</Button
						>
						<Banner tone="success" message={msg.saved} />
						<Banner tone="error" message={msg.error} />
					</form>
				</li>
			{/each}
		</ul>
		{#if data.typesFull}
			<p class="muted">The maximum of 20 leave types is reached.</p>
		{:else}
			{@const msg = messageFor('type')}
			{@const errors = errorsFor('type')}
			<form
				method="POST"
				action="?year={data.year}&/typeSave"
				class="add-form"
				use:enhance={saveWith('type', true)}
			>
				<h3>Add a leave type</h3>
				<TextField label="Name" name="name" maxlength={40} error={errors.name} required />
				<Select
					label="Counted as"
					name="kind"
					options={kindOptions}
					value="logged"
					error={errors.kind}
				/>
				<TextField
					label="Days per year (balance only)"
					name="annualDays"
					inputmode="decimal"
					error={errors.annualDays}
				/>
				<label class="check"><input type="checkbox" name="requiresReason" />Reason required</label>
				<div>
					<Button type="submit" loading={saving === 'type'} loadingLabel="Adding…"
						>Add leave type</Button
					>
				</div>
				<Banner tone="success" message={msg.saved} />
				<Banner tone="error" message={msg.error} />
			</form>
		{/if}
	</section>

	<section class="card" aria-labelledby="hol-h">
		<h2 id="hol-h">Holidays {data.year}</h2>
		<form method="GET" class="inline">
			<Select label="Year" name="year" options={yearOptions} value={String(data.year)} />
			<Button type="submit">Show</Button>
		</form>
		{#if data.holidays.length === 0}
			<EmptyState
				title="No holidays entered for {data.year}"
				description="Add each public holiday and cuti bersama below."
			/>
		{:else}
			<ul class="rows" aria-label="Holidays {data.year}">
				{#each data.holidays as h (h.id)}
					<li class="holiday">
						<span
							><strong>{h.onDate}</strong> · {h.name}{#if h.deductsLeave}
								· deducts leave{/if}</span
						>
						<form
							method="POST"
							action="?year={data.year}&/holidayDelete"
							use:enhance={saveWith(`del:${h.id}`)}
						>
							<input type="hidden" name="id" value={h.id} />
							<Button
								type="submit"
								size="sm"
								variant="danger"
								loading={saving === `del:${h.id}`}
								label="Remove {h.name} on {h.onDate}">Remove</Button
							>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
		<form
			method="POST"
			action="?year={data.year}&/holidaySave"
			class="add-form"
			use:enhance={saveWith('holiday', true)}
		>
			<h3>Add a holiday</h3>
			<TextField
				label="Date"
				name="onDate"
				type="date"
				error={errorsFor('holiday').onDate}
				required
			/>
			<TextField
				label="Holiday name"
				name="name"
				maxlength={80}
				error={errorsFor('holiday').name}
				required
			/>
			<label class="check"
				><input type="checkbox" name="deductsLeave" />Deducts annual leave (cuti bersama taken from
				the balance)</label
			>
			<div>
				<Button type="submit" loading={saving === 'holiday'} loadingLabel="Adding…"
					>Add holiday</Button
				>
			</div>
			<Banner tone="success" message={messageFor('holiday').saved} />
			<Banner tone="error" message={messageFor('holiday').error} />
		</form>
	</section>

	<section class="card" aria-labelledby="wd-h">
		<h2 id="wd-h">Work days</h2>
		<form
			method="POST"
			action="?year={data.year}&/workDays"
			class="add-form"
			use:enhance={saveWith('workDays')}
		>
			<input type="hidden" name="expected" value={data.workDaysUpdatedAt} />
			<fieldset>
				<legend>Days that count as leave days</legend>
				<div class="days">
					{#each WEEKDAY_NAMES as name, i (name)}
						<label class="check"
							><input
								type="checkbox"
								name="day"
								value={String(i + 1)}
								checked={data.workDays.includes(i + 1)}
							/>{name}</label
						>
					{/each}
				</div>
				<FieldError id="days-error" message={errorsFor('workDays').days} />
			</fieldset>
			<div>
				<Button type="submit" loading={saving === 'workDays'} loadingLabel="Saving…"
					>Save work days</Button
				>
			</div>
			<Banner tone="success" message={messageFor('workDays').saved} />
			<Banner tone="error" message={messageFor('workDays').error} />
		</form>
	</section>

	<section class="card" aria-labelledby="grant-h">
		<h2 id="grant-h">Yearly entitlements</h2>
		<p class="muted">
			Entitlements are granted automatically when someone first opens their time off; this grants
			them for everyone with a start date at once. Running it twice adds nothing.
		</p>
		<form
			method="POST"
			action="?year={data.year}&/grantYear"
			class="inline"
			use:enhance={saveWith('grant')}
		>
			<Select label="Year" name="year" options={yearOptions} value={String(data.thisYear)} />
			<Button type="submit" loading={saving === 'grant'} loadingLabel="Granting…"
				>Grant entitlements</Button
			>
		</form>
		<Banner tone="success" message={messageFor('grant').saved} />
		<Banner tone="error" message={messageFor('grant').error} />
	</section>

	<section class="card" aria-labelledby="adj-h">
		<h2 id="adj-h">Adjust a balance</h2>
		{#if balanceTypes.length === 0 || data.employees.length === 0}
			<p class="muted">Adjustments need an employee and a leave type with a yearly balance.</p>
		{:else}
			<form
				method="POST"
				action="?year={data.year}&/adjust"
				class="add-form"
				use:enhance={saveWith('adjust', true)}
			>
				<Select
					label="Employee"
					name="employeeId"
					options={employeeOptions}
					error={errorsFor('adjust').employeeId}
					required
				/>
				<Select
					label="Leave type"
					name="typeId"
					options={adjustTypeOptions}
					error={errorsFor('adjust').typeId}
				/>
				<Select
					label="Year"
					name="period"
					options={yearOptions}
					value={String(data.thisYear)}
					error={errorsFor('adjust').period}
				/>
				<TextField
					label="Days (negative to deduct)"
					name="days"
					inputmode="decimal"
					hint="-60 to 60, in steps of 0.5."
					error={errorsFor('adjust').days}
					required
				/>
				<TextField
					label="Note"
					name="note"
					maxlength={200}
					error={errorsFor('adjust').note}
					required
				/>
				<div>
					<Button type="submit" loading={saving === 'adjust'} loadingLabel="Saving…"
						>Save adjustment</Button
					>
				</div>
				<Banner tone="success" message={messageFor('adjust').saved} />
				<Banner tone="error" message={messageFor('adjust').error} />
			</form>
		{/if}
	</section>
</div>

<style>
	.sections {
		display: grid;
		gap: 18px;
		min-width: 0;
	}
	.card {
		display: grid;
		gap: 12px;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
		min-width: 0;
	}
	h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
	}
	h3 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
	}
	.rows > li {
		padding: 10px 12px;
		min-width: 0;
	}
	.rows > li + li {
		border-top: 1px solid var(--border);
	}
	.type-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
		align-items: end;
	}
	@media (min-width: 900px) {
		.type-form {
			grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto auto auto;
		}
	}
	.kind {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
	.holiday {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 14px;
	}
	.add-form {
		display: grid;
		gap: 10px;
		max-width: 520px;
	}
	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 8px;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 36px;
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
		flex: none;
	}
	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	legend {
		margin-bottom: 6px;
		font-size: 13px;
		font-weight: 500;
	}
	.days {
		display: flex;
		flex-wrap: wrap;
		gap: 0 16px;
	}
	.muted {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
</style>
