<script lang="ts">
	import { enhance } from '$app/forms';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { form } = $props();
	let pending = $state(false);
</script>

<svelte:head><title>Sign in · Ruby</title></svelte:head>

<h1>Sign in</h1>
<p class="lead">Use the account your admin invited you to.</p>

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
	<Banner tone="error" message={form?.error} />
	<TextField
		label="E-mail"
		name="email"
		type="email"
		autocomplete="username"
		inputmode="email"
		required
		maxlength={254}
		value={form?.values?.email ?? ''}
	/>
	<TextField
		label="Password"
		name="password"
		type="password"
		autocomplete="current-password"
		required
	/>
	<Button type="submit" variant="primary" full loading={pending} loadingLabel="Signing in…">
		Sign in
	</Button>
</form>

<p class="note">No account? Ask an admin of your team for an invite link.</p>

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
	}
	.form {
		display: grid;
		gap: 14px;
	}
	.note {
		margin: 18px 0 0;
		color: var(--muted);
		font-size: 13px;
	}
</style>
