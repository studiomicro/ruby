<script lang="ts">
	import { enhance } from '$app/forms';
	import { USER_ROLES } from '#lib/shared/enums';
	import Avatar from '#lib/ui/kit/Avatar.svelte';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/kit/EmptyState.svelte';
	import LocalTime from '#lib/ui/kit/LocalTime.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data, form } = $props();

	const ROLE_OPTIONS = USER_ROLES.map((r) => ({
		value: r,
		label: r === 'admin' ? 'Admin' : 'Member'
	}));
	let inviting = $state(false);
	/** The row (`kind:id`) whose form is being sent; its buttons show the loading state. */
	let busy = $state<string | null>(null);
	let copied = $state(false);

	const submitting = (key: string) => () => {
		busy = key;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = null;
		};
	};

	async function copyLink(link: string) {
		try {
			await navigator.clipboard.writeText(link);
			copied = true;
		} catch {
			copied = false;
		}
	}
</script>

<PageHeader title="Users" description="Invite people, change roles and disable accounts." />

<div class="layout">
	<section class="panel" aria-labelledby="invite-heading">
		<h2 id="invite-heading">Invite someone</h2>
		<form
			method="POST"
			action="?/invite"
			class="invite-form"
			use:enhance={() => {
				inviting = true;
				copied = false;
				return async ({ update }) => {
					await update();
					inviting = false;
				};
			}}
		>
			<div class="grow">
				<TextField
					label="E-mail"
					name="email"
					type="email"
					inputmode="email"
					autocomplete="off"
					required
					maxlength={254}
					value={form?.inviteEmail ?? ''}
					error={form?.inviteError}
				/>
			</div>
			<Select label="Role" name="role" options={ROLE_OPTIONS} value="member" />
			<div class="submit">
				<Button type="submit" variant="primary" loading={inviting} loadingLabel="Creating…">
					Create invite link
				</Button>
			</div>
		</form>

		{#if form?.invited}
			<div class="link-box" role="status">
				<p>
					Invite link for <strong>{form.invited.email}</strong>. Copy it now and send it to them: it
					is shown only once, works once, and expires <LocalTime at={form.invited.expiresAt} />.
				</p>
				<div class="link-row">
					<label class="sr-only" for="invite-link">Invite link</label>
					<input id="invite-link" readonly value={form.invited.link} />
					<Button onclick={() => copyLink(form.invited.link)}>{copied ? 'Copied' : 'Copy'}</Button>
				</div>
			</div>
		{/if}
	</section>

	<Banner tone="error" message={form?.rowError} />
	<Banner tone="success" message={form?.rowNotice} />

	<section aria-labelledby="pending-heading">
		<h2 id="pending-heading">Pending invites</h2>
		{#if data.invites.length === 0}
			<p class="muted">No pending invites.</p>
		{:else}
			<ul class="rows">
				{#each data.invites as invite (invite.id)}
					<li class="row">
						<div class="main-cell">
							<span class="primary-text">{invite.email}</span>
							<span class="secondary-text"
								>Invited by {invite.createdByName} · expires <LocalTime
									at={invite.expiresAt}
								/></span
							>
						</div>
						<Badge tone={invite.role === 'admin' ? 'accent' : 'neutral'}
							>{invite.role === 'admin' ? 'Admin' : 'Member'}</Badge
						>
						<form
							method="POST"
							action="?/revokeInvite"
							use:enhance={submitting(`invite:${invite.id}`)}
						>
							<input type="hidden" name="inviteId" value={invite.id} />
							<Button
								type="submit"
								size="sm"
								variant="danger"
								loading={busy === `invite:${invite.id}`}>Revoke</Button
							>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section aria-labelledby="users-heading">
		<h2 id="users-heading">People</h2>
		{#if data.users.length === 0}
			<EmptyState title="No users yet" />
		{:else}
			<ul class="rows">
				{#each data.users as user (user.id)}
					{@const self = user.id === data.selfId}
					<li class="row" class:disabled={user.status === 'disabled'}>
						<Avatar name={user.name} seed={user.id} />
						<div class="main-cell">
							<span class="primary-text"
								>{user.name}{#if self}<span class="you"> (you)</span>{/if}</span
							>
							<span class="secondary-text"
								>{user.email} · last sign-in <LocalTime
									at={user.lastLoginAt}
									fallback="never"
								/></span
							>
						</div>
						{#if user.status === 'disabled'}<Badge tone="danger">Disabled</Badge>{/if}
						{#if user.isHr}<Badge tone="accent">HR</Badge>{/if}
						{#if user.lockedUntil !== null}
							<span class="locked">Locked until <LocalTime at={user.lockedUntil} withTime /></span>
							<form method="POST" action="?/unlock" use:enhance={submitting(`unlock:${user.id}`)}>
								<input type="hidden" name="userId" value={user.id} />
								<Button type="submit" size="sm" loading={busy === `unlock:${user.id}`}
									>Unlock</Button
								>
							</form>
						{/if}
						<form
							method="POST"
							action="?/setRole"
							class="role-form"
							use:enhance={submitting(`role:${user.id}`)}
						>
							<input type="hidden" name="userId" value={user.id} />
							<Select
								label="Role of {user.name}"
								hideLabel
								name="role"
								options={ROLE_OPTIONS}
								value={user.role}
							/>
							<Button type="submit" size="sm" loading={busy === `role:${user.id}`}>Set</Button>
						</form>
						{#if user.status === 'active'}
							<!-- RB-05: the HR capability (audited in the HR audit log). -->
							<form method="POST" action="?/setHr" use:enhance={submitting(`hr:${user.id}`)}>
								<input type="hidden" name="userId" value={user.id} />
								<input type="hidden" name="isHr" value={user.isHr ? '0' : '1'} />
								<Button
									type="submit"
									size="sm"
									label="{user.isHr ? 'Revoke HR access from' : 'Grant HR access to'} {user.name}"
									loading={busy === `hr:${user.id}`}>{user.isHr ? 'Revoke HR' : 'Grant HR'}</Button
								>
							</form>
						{/if}
						{#if !self}
							<form
								method="POST"
								action="?/setStatus"
								use:enhance={submitting(`status:${user.id}`)}
							>
								<input type="hidden" name="userId" value={user.id} />
								<input
									type="hidden"
									name="status"
									value={user.status === 'active' ? 'disabled' : 'active'}
								/>
								<Button
									type="submit"
									size="sm"
									variant={user.status === 'active' ? 'danger' : 'secondary'}
									loading={busy === `status:${user.id}`}
									>{user.status === 'active' ? 'Disable' : 'Enable'}</Button
								>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.layout {
		display: grid;
		gap: 24px;
		max-width: 900px;
	}
	.panel {
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
		margin: 0 0 12px;
		font-size: 16px;
		font-weight: 600;
	}
	.invite-form {
		display: grid;
		gap: 12px;
		grid-template-columns: minmax(0, 1fr);
	}
	@media (min-width: 640px) {
		.invite-form {
			grid-template-columns: minmax(0, 1fr) 140px auto;
			align-items: start;
		}
		.submit {
			padding-top: 25px;
		}
	}
	.link-box {
		display: grid;
		gap: 10px;
		margin-top: 16px;
		padding: 14px;
		border-radius: var(--radius-m);
		background: var(--warning-soft);
		font-size: 14px;
	}
	.link-box p {
		margin: 0;
	}
	.link-row {
		display: flex;
		gap: 8px;
		min-width: 0;
	}
	.link-row input {
		flex: 1;
		min-width: 0;
		min-height: 36px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-m);
		background: var(--surface);
		color: var(--fg);
		font-family: var(--font-mono);
	}
	.muted {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 12px;
		padding: 12px 14px;
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.row.disabled .main-cell {
		opacity: 0.65;
	}
	.main-cell {
		display: grid;
		flex: 1 1 220px;
		min-width: 0;
	}
	.primary-text {
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.you {
		color: var(--muted);
		font-weight: 400;
	}
	.secondary-text {
		color: var(--muted);
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.locked {
		color: var(--danger);
		font-size: 13px;
	}
	.role-form {
		display: flex;
		align-items: center;
		gap: 6px;
	}
</style>
