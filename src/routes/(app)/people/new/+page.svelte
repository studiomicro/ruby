<script lang="ts">
	import { enhance } from '$app/forms';
	import WorkFields from '#lib/ui/hr/WorkFields.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';

	let { data, form } = $props();
	let saving = $state(false);
	const errors = $derived((form?.errors ?? {}) as Record<string, string | undefined>);
	const values = $derived((form?.values ?? {}) as Record<string, string | null>);
</script>

<PageHeader
	title="Add employee"
	description="Work and employment details. Add sensitive details and link an account afterwards."
/>

<form
	method="POST"
	class="panel form"
	use:enhance={() => {
		saving = true;
		return async ({ update }) => {
			await update({ reset: false });
			saving = false;
		};
	}}
>
	<Banner tone="error" message={errors.form} />
	<WorkFields {values} {errors} managers={data.managers} />
	<div class="actions">
		<Button type="submit" variant="primary" loading={saving} loadingLabel="Creating…"
			>Create employee</Button
		>
		<Button href="/people" variant="ghost">Cancel</Button>
	</div>
</form>

<style>
	.panel {
		max-width: 820px;
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
		gap: 16px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
