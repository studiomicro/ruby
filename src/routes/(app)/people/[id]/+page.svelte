<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { EMPLOYMENT_TYPE_LABELS } from '#lib/shared/enums';
	import RevealValue from '#lib/ui/hr/RevealValue.svelte';
	import { tenure } from '#lib/ui/hr/tenure';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import TextArea from '#lib/ui/kit/TextArea.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data, form } = $props();
	const e = $derived(data.employee);
	const action = $derived(`/people/${e.id}?/reveal`);
	const f = $derived((form ?? {}) as Record<string, unknown>);
	const revealed = $derived(
		(f.revealed ?? null) as { field: string; ref: string; value: string } | null
	);
	const revealedFor = (field: string, ref = '') =>
		revealed && revealed.field === field && revealed.ref === ref ? revealed.value : null;
	const revealError = $derived((f.revealError as string | undefined) ?? null);
	const selfErrors = $derived((f.selfErrors ?? {}) as Record<string, string | undefined>);
	const selfValues = $derived((f.selfValues ?? {}) as Record<string, string | null | undefined>);
	const personalErrors = $derived((f.personalErrors ?? {}) as Record<string, string | undefined>);
	const contactErrors = $derived((f.contactErrors ?? {}) as Record<string, string | undefined>);
	const contactValues = $derived((f.contactValues ?? {}) as Record<string, string | undefined>);
	const notice = $derived(
		page.url.searchParams.get('notice') === 'created' ? 'Employee created.' : null
	);
	const title = $derived(e.preferredName ? `${e.fullName} (${e.preferredName})` : e.fullName);
	const subtitle = $derived([e.jobTitle, e.department, e.location].filter(Boolean).join(' · '));
	const since = $derived(data.employment ? tenure(data.employment.startOn, data.today) : null);
	let saving = $state<string | null>(null);

	/** use:enhance that marks `name` as saving and keeps the typed values on a refusal. */
	const saveWith = (name: string) => () => {
		saving = name;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			saving = null;
		};
	};
</script>

<PageHeader {title} description={subtitle || undefined}>
	{#snippet actions()}
		<Button href="/people" variant="ghost">Directory</Button>
		{#if data.access.hr}<Button href="/people/{e.id}/edit" variant="primary">Edit</Button>{/if}
	{/snippet}
</PageHeader>

<div class="sections">
	<Banner tone="success" message={notice} />
	<Banner tone="error" message={revealError} />
	{#if data.hrInfo?.deleted}
		<Banner tone="warning" message="This employee record is deleted. Restore it from Edit." />
	{/if}
	{#if data.employment?.status === 'terminated' && data.hrInfo?.linkedUserActive}
		<Banner tone="warning" message="This account is still active. Ask an admin to deactivate it." />
	{/if}

	<section class="panel" aria-labelledby="h-contact">
		<div class="chips">
			{#if data.employment}
				{#if data.employment.status === 'terminated'}<Badge tone="warning">Former employee</Badge
					>{:else}<Badge tone="success">Active</Badge>{/if}
			{/if}
			{#if data.access.self}<Badge tone="accent">You</Badge>{/if}
			{#if data.access.manager}<Badge>Your direct report</Badge>{/if}
			{#if data.hrInfo}
				{#if data.hrInfo.linkedUserName}<Badge>Account: {data.hrInfo.linkedUserName}</Badge>
				{:else}<Badge>No linked account</Badge>{/if}
			{/if}
		</div>
		<h2 id="h-contact">Contact</h2>
		<dl>
			<div>
				<dt>Work e-mail</dt>
				<dd>
					{#if e.workEmail}<a href="mailto:{e.workEmail}">{e.workEmail}</a>{:else}<span class="none"
							>Not set</span
						>{/if}
				</dd>
			</div>
			<div>
				<dt>Work phone</dt>
				<dd>
					{#if e.workPhone}<a href="tel:{e.workPhone.replace(/[^+0-9]/g, '')}">{e.workPhone}</a
						>{:else}<span class="none">Not set</span>{/if}
				</dd>
			</div>
			<div>
				<dt>Manager</dt>
				<dd>
					{#if e.managerId && e.managerName}<a href="/people/{e.managerId}">{e.managerName}</a
						>{:else}<span class="none">None</span>{/if}
				</dd>
			</div>
		</dl>
	</section>

	{#if data.employment}
		{@const em = data.employment}
		<section class="panel" aria-labelledby="h-employment">
			<h2 id="h-employment">Employment</h2>
			<dl>
				<div>
					<dt>Employee number</dt>
					<dd>{em.employeeNo ?? '—'}</dd>
				</div>
				<div>
					<dt>Type</dt>
					<dd>{EMPLOYMENT_TYPE_LABELS[em.employmentType]}</dd>
				</div>
				<div>
					<dt>Start date</dt>
					<dd>
						{em.startOn ?? '—'}{#if since}<span class="muted"> · {since}</span>{/if}
					</dd>
				</div>
				<div>
					<dt>Probation ends</dt>
					<dd>{em.probationEndsOn ?? '—'}</dd>
				</div>
				{#if em.endOn}
					<div>
						<dt>End date</dt>
						<dd>{em.endOn}</dd>
					</div>
				{/if}
			</dl>
		</section>
	{/if}

	{#if data.personal}
		<section class="panel" aria-labelledby="h-personal">
			<h2 id="h-personal">Personal and sensitive</h2>
			<p class="hint">
				Visible to {data.access.self ? 'you' : 'this employee'} and HR only. Every reveal is recorded
				in the HR audit log.
			</p>
			{#if !data.keyReady}
				<Banner
					tone="warning"
					message="Sensitive data storage is not configured. These fields are read-only."
				/>
			{/if}
			<dl>
				{#each data.personal.fields as item (item.field)}
					<div>
						<dt>{item.label}</dt>
						<dd>
							<RevealValue
								{action}
								field={item.field}
								label={item.label}
								masked={item.masked}
								empty={!item.set}
								disabled={!data.keyReady}
								revealed={revealedFor(item.field)}
								multiline={item.field === 'home_address'}
							/>
						</dd>
					</div>
				{/each}
				<div>
					<dt>Bank name</dt>
					<dd>{data.personal.bankName ?? 'Not set'}</dd>
				</div>
			</dl>
		</section>
	{/if}

	{#if data.contacts}
		<section class="panel" aria-labelledby="h-emergency">
			<h2 id="h-emergency">Emergency contacts</h2>
			<Banner tone="success" message={(f.contactSaved as string | undefined) ?? null} />
			<Banner tone="error" message={contactErrors.form} />
			{#if data.contacts.length === 0}
				<p class="none">No emergency contacts yet.</p>
			{:else}
				<ul class="contacts">
					{#each data.contacts as c (c.id)}
						<li>
							<div class="contact-head">
								<strong>{c.relationship}</strong>
								{#if data.access.self || data.access.hr}
									<form method="POST" action="?/removeContact" use:enhance={saveWith(`rm-${c.id}`)}>
										<input type="hidden" name="contactId" value={c.id} />
										<Button
											type="submit"
											size="sm"
											variant="ghost"
											loading={saving === `rm-${c.id}`}>Remove</Button
										>
									</form>
								{/if}
							</div>
							<dl>
								<div>
									<dt>Name</dt>
									<dd>
										<RevealValue
											{action}
											field="contact_name"
											ref={c.id}
											label="name of {c.relationship}"
											masked="Hidden"
											disabled={!data.keyReady}
											revealed={revealedFor('contact_name', c.id)}
										/>
									</dd>
								</div>
								<div>
									<dt>Phone</dt>
									<dd>
										<RevealValue
											{action}
											field="contact_phone"
											ref={c.id}
											label="phone of {c.relationship}"
											masked="Hidden"
											disabled={!data.keyReady}
											revealed={revealedFor('contact_phone', c.id)}
										/>
									</dd>
								</div>
							</dl>
						</li>
					{/each}
				</ul>
			{/if}
			{#if data.contacts.length < data.contactsMax && data.keyReady}
				<form method="POST" action="?/addContact" class="form" use:enhance={saveWith('contact')}>
					<h3>Add a contact</h3>
					<div class="grid">
						<TextField
							label="Name"
							name="contactName"
							required
							maxlength={100}
							error={contactErrors.contactName}
							autocomplete="off"
						/>
						<TextField
							label="Relationship"
							name="relationship"
							required
							maxlength={40}
							value={contactValues.relationship ?? ''}
							error={contactErrors.relationship}
						/>
						<TextField
							label="Phone"
							name="contactPhone"
							required
							inputmode="tel"
							maxlength={20}
							error={contactErrors.contactPhone}
							autocomplete="off"
						/>
					</div>
					<div>
						<Button type="submit" loading={saving === 'contact'} loadingLabel="Adding…"
							>Add contact</Button
						>
					</div>
				</form>
			{/if}
		</section>
	{/if}

	{#if data.compensation}
		<section class="panel" aria-labelledby="h-salary">
			<h2 id="h-salary">Salary</h2>
			<p class="hint">HR only. Each reveal is recorded. Add records from Edit.</p>
			{#if data.compensation.length === 0}
				<p class="none">No salary records.</p>
			{:else}
				<ul class="salary">
					{#each data.compensation as c (c.id)}
						<li>
							<span class="effective">From {c.effectiveOn}</span>
							<RevealValue
								{action}
								field="compensation_amount"
								ref={c.id}
								label="salary from {c.effectiveOn}"
								masked="Rp ••••••"
								disabled={!data.keyReady}
								revealed={revealedFor('compensation_amount', c.id)}
							/>
							{#if c.hasNote}
								<RevealValue
									{action}
									field="compensation_note"
									ref={c.id}
									label="note of salary from {c.effectiveOn}"
									masked="Note hidden"
									disabled={!data.keyReady}
									revealed={revealedFor('compensation_note', c.id)}
								/>
							{/if}
							<span class="muted small"
								>Recorded <LocalTime at={c.createdAt} />{#if c.createdByName}
									by {c.createdByName}{/if}</span
							>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	{#if data.access.self}
		<section class="panel" aria-labelledby="h-self">
			<h2 id="h-self">Edit your details</h2>
			<form method="POST" action="?/updateSelf" class="form" use:enhance={saveWith('self')}>
				<Banner tone="success" message={(f.selfSaved as string | undefined) ?? null} />
				<Banner tone="error" message={selfErrors.form} />
				<input type="hidden" name="expectedUpdatedAt" value={e.updatedAt} />
				<div class="grid">
					<TextField
						label="Preferred name"
						name="preferredName"
						maxlength={60}
						value={selfValues.preferredName ?? e.preferredName ?? ''}
						error={selfErrors.preferredName}
					/>
					<TextField
						label="Work phone"
						name="workPhone"
						inputmode="tel"
						maxlength={20}
						value={selfValues.workPhone ?? e.workPhone ?? ''}
						error={selfErrors.workPhone}
					/>
				</div>
				<div>
					<Button type="submit" variant="primary" loading={saving === 'self'} loadingLabel="Saving…"
						>Save</Button
					>
				</div>
			</form>
			{#if data.personal}
				<form
					method="POST"
					action="?/updateSelfPersonal"
					class="form"
					use:enhance={saveWith('personal')}
				>
					<h3>Personal phone and home address</h3>
					<Banner tone="success" message={(f.personalSaved as string | undefined) ?? null} />
					<Banner tone="error" message={personalErrors.form} />
					<p class="hint">Leave a field empty to keep what is stored.</p>
					<input type="hidden" name="expectedUpdatedAt" value={data.personal.updatedAt} />
					<TextField
						label="Personal phone"
						name="personal_phone"
						inputmode="tel"
						maxlength={20}
						error={personalErrors.personal_phone}
						disabled={!data.keyReady}
						autocomplete="off"
					/>
					<label class="check"
						><input type="checkbox" name="clear_personal_phone" disabled={!data.keyReady} /> Remove the
						stored personal phone</label
					>
					<TextArea
						label="Home address"
						name="home_address"
						rows={3}
						maxlength={500}
						error={personalErrors.home_address}
						disabled={!data.keyReady}
					/>
					<label class="check"
						><input type="checkbox" name="clear_home_address" disabled={!data.keyReady} /> Remove the
						stored home address</label
					>
					<div>
						<Button
							type="submit"
							variant="primary"
							disabled={!data.keyReady}
							loading={saving === 'personal'}
							loadingLabel="Saving…">Save personal details</Button
						>
					</div>
				</form>
			{/if}
		</section>
	{/if}
</div>

<style>
	.sections {
		display: grid;
		gap: 16px;
		max-width: 820px;
	}
	.panel {
		display: grid;
		gap: 12px;
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
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chips:empty {
		display: none;
	}
	dl {
		display: grid;
		gap: 10px;
		margin: 0;
	}
	dl > div {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 2px;
		min-width: 0;
	}
	@media (min-width: 640px) {
		dl > div {
			grid-template-columns: 180px minmax(0, 1fr);
			align-items: center;
			gap: 12px;
		}
	}
	dt {
		color: var(--muted);
		font-size: 13px;
	}
	dd {
		min-width: 0;
		margin: 0;
		overflow-wrap: anywhere;
	}
	dd a {
		color: var(--fg);
	}
	@media (pointer: coarse) {
		dd a {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}
	}
	.none,
	.muted,
	.hint {
		color: var(--muted);
	}
	.hint,
	.none {
		margin: 0;
		font-size: 13px;
	}
	.small {
		font-size: 12px;
	}
	.contacts,
	.salary {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.contacts > li,
	.salary > li {
		display: grid;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		min-width: 0;
	}
	.contact-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.effective {
		font-weight: 500;
	}
	.form {
		display: grid;
		gap: 12px;
		min-width: 0;
	}
	.form + .form {
		margin-top: 8px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
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
	}
</style>
