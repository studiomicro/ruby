<script lang="ts">
	import { enhance } from '#lib/ui/pwa/offline-form';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let { form } = $props();
	let pending = $state(false);
	const errors = $derived(
		(form?.errors ?? {}) as Partial<Record<'form' | 'name' | 'email' | 'password', string>>
	);
</script>

<svelte:head><title>Set up Ruby</title></svelte:head>

<h1>Set up Ruby</h1>
<p class="lead">
	Create the first account. It becomes the admin, who invites everyone else. This page disappears
	once it is done.
</p>

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
	<Banner tone="error" message={errors.form} />
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
		label="E-mail"
		name="email"
		type="email"
		autocomplete="username"
		inputmode="email"
		required
		maxlength={254}
		value={form?.values?.email ?? ''}
		error={errors.email}
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
		Create admin account
	</Button>
</form>

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
</style>
