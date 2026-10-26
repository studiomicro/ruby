<script lang="ts">
	import { enhance } from '$app/forms';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { data, form } = $props();
	let pending = $state(false);
	const errors = $derived(
		(form?.errors ?? {}) as Partial<Record<'form' | 'name' | 'password', string>>
	);
</script>

<svelte:head><title>Join Ruby</title></svelte:head>

{#if data.invite && !errors.form}
	<h1>Join your team on Ruby</h1>
	<p class="lead">
		You were invited as <strong>{data.invite.email}</strong>
		<Badge tone={data.invite.role === 'admin' ? 'accent' : 'neutral'}
			>{data.invite.role === 'admin' ? 'Admin' : 'Member'}</Badge
		>. Choose your name and a password.
	</p>
	{#if data.signedInAs}
		<Banner tone="info" message="Accepting signs this browser out of {data.signedInAs}." />
	{/if}
	<form
		method="POST"
		class="form"
		use:enhance={() => {
			pending = true;
			return async ({ update }) => {
				await update();
				pending = false;
			};
		}}
	>
		<TextField label="E-mail" name="email-shown" value={data.invite.email} readonly />
		<TextField
			label="Your name"
			name="name"
			autocomplete="name"
			required
			maxlength={80}
			value={form?.values?.name ?? ''}
			error={errors.name}
		/>
		<TextField
			label="Password"
			name="password"
			type="password"
			autocomplete="new-password"
			required
			minlength={10}
			hint="At least 10 characters."
			error={errors.password}
		/>
		<Button type="submit" variant="primary" full loading={pending} loadingLabel="Creating account…">
			Create account
		</Button>
	</form>
{:else}
	<h1>Invite link not valid</h1>
	<p class="lead">
		{errors.form ?? 'This invite link is no longer valid. Ask an admin for a new one.'}
	</p>
	<Button href="/login" variant="secondary">Go to sign in</Button>
{/if}

<style>
	h1 {
		margin: 0;
		font-size: 20px;
		font-weight: 600;
	}
	.lead {
		margin: 4px 0 20px;
		color: var(--muted);
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.lead strong {
		color: var(--fg);
		font-weight: 500;
	}
	.form {
		display: grid;
		gap: 14px;
		margin-top: 14px;
	}
</style>
