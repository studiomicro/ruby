<script lang="ts">
	import { enhance } from '$app/forms';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data, form } = $props();
	let savingName = $state(false);
	let savingPassword = $state(false);
	const passwordErrors = $derived(
		(form?.passwordErrors ?? {}) as Partial<Record<'form' | 'current' | 'next', string>>
	);
</script>

<PageHeader title="Account" description="Your profile and password." />

<div class="sections">
	<section class="panel" aria-labelledby="profile-heading">
		<h2 id="profile-heading">Profile</h2>
		<dl>
			<dt>E-mail</dt>
			<dd>{data.account.email}</dd>
			<dt>Role</dt>
			<dd>
				<Badge tone={data.account.role === 'admin' ? 'accent' : 'neutral'}
					>{data.account.role === 'admin' ? 'Admin' : 'Member'}</Badge
				>
			</dd>
		</dl>
		<form
			method="POST"
			action="?/name"
			class="form"
			use:enhance={() => {
				savingName = true;
				return async ({ update }) => {
					await update({ reset: false });
					savingName = false;
				};
			}}
		>
			<Banner tone="success" message={form?.nameSaved ? 'Name saved.' : null} />
			<TextField
				label="Name"
				name="name"
				autocomplete="name"
				required
				maxlength={80}
				value={data.account.name}
				error={form?.nameError}
			/>
			<div>
				<Button type="submit" loading={savingName} loadingLabel="Saving…">Save name</Button>
			</div>
		</form>
	</section>

	<section class="panel" aria-labelledby="password-heading">
		<h2 id="password-heading">Password</h2>
		<p class="help">Changing it signs you out on every other device.</p>
		<form
			method="POST"
			action="?/password"
			class="form"
			use:enhance={() => {
				savingPassword = true;
				return async ({ update }) => {
					await update();
					savingPassword = false;
				};
			}}
		>
			<Banner tone="error" message={passwordErrors.form} />
			<Banner
				tone="success"
				message={form?.passwordSaved ? 'Password changed. Other devices were signed out.' : null}
			/>
			<TextField
				label="Current password"
				name="current"
				type="password"
				autocomplete="current-password"
				required
				error={passwordErrors.current}
			/>
			<TextField
				label="New password"
				name="next"
				type="password"
				autocomplete="new-password"
				required
				minlength={10}
				hint="At least 10 characters."
				error={passwordErrors.next}
			/>
			<div>
				<Button type="submit" loading={savingPassword} loadingLabel="Changing…"
					>Change password</Button
				>
			</div>
		</form>
	</section>
</div>

<style>
	.sections {
		display: grid;
		gap: 20px;
		max-width: 560px;
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
	.help {
		margin: -6px 0 14px;
		color: var(--muted);
		font-size: 14px;
	}
	dl {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 6px 16px;
		margin: 0 0 16px;
		font-size: 14px;
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
	}
	.form {
		display: grid;
		gap: 14px;
	}
</style>
