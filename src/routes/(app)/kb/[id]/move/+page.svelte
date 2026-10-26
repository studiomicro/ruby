<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import Breadcrumbs from '../../Breadcrumbs.svelte';

	let { data, form } = $props();

	const errors = $derived(
		(form?.errors ?? {}) as Partial<Record<'form' | 'parent' | 'placement', string>>
	);
	const scopeOptions = $derived([
		{ value: 'team', label: 'Team (team-wide pages)' },
		...data.projects.map((p) => ({
			value: p.key,
			label: `${p.name} (${p.key})${p.archived ? ' — archived' : ''}`
		}))
	]);
	const parentChoices = $derived([{ value: '', label: 'Top level' }, ...data.parents]);
	// Writable deriveds: follow the server's values, take the user's choice.
	let parentId = $derived(form?.values?.parentId ?? data.currentParentId);
	let placement = $derived(form?.values?.placement ?? 'last');
	/** With JavaScript only the chosen parent's children are offered to go after; without it, all of them. */
	let js = $state(false);
	onMount(() => {
		js = true;
	});
	const placementChoices = $derived([
		{ value: 'last', label: 'Last' },
		{ value: 'first', label: 'First' },
		...data.siblings
			.filter((s) => !js || s.parentId === parentId)
			.map((s) => ({
				value: `after:${s.value}`,
				label: `After “${s.label.replace(/^(— )+/, '')}”`
			}))
	]);
	// A choice the new parent no longer offers falls back to "Last".
	$effect(() => {
		if (!placementChoices.some((c) => c.value === placement)) placement = 'last';
	});
	let moving = $state(false);
	let scopeForm = $state<HTMLFormElement>();
</script>

<Breadcrumbs project={data.page.project} ancestors={data.breadcrumbs} current={data.page} />
<PageHeader
	title="Move “{data.page.title}”"
	description={data.subpages > 0
		? `Its ${data.subpages} subpage${data.subpages === 1 ? '' : 's'} move with it.`
		: undefined}
/>

<div class="panel">
	<form method="GET" class="scope-form" bind:this={scopeForm}>
		<div class="grow">
			<Select
				label="Space"
				name="scope"
				options={scopeOptions}
				value={data.scope}
				onchange={() => scopeForm?.requestSubmit()}
			/>
		</div>
		<noscript><Button type="submit">Show pages</Button></noscript>
	</form>

	<form
		method="POST"
		action="?/move"
		class="move-form"
		use:enhance={() => {
			moving = true;
			return async ({ update }) => {
				await update({ reset: false });
				moving = false;
			};
		}}
	>
		<Banner tone="error" message={errors.form} />
		<input type="hidden" name="scope" value={data.scope} />
		<Select
			label="Parent in {data.scopeName}"
			name="parentId"
			options={parentChoices}
			bind:value={parentId}
			error={errors.parent}
		/>
		<Select
			label="Place among its new siblings"
			name="placement"
			options={placementChoices}
			bind:value={placement}
			error={errors.placement}
		/>
		<div class="actions">
			<Button type="submit" variant="primary" loading={moving} loadingLabel="Moving…"
				>Move page</Button
			>
			<Button href="/kb/{data.page.id}" variant="ghost">Cancel</Button>
		</div>
	</form>
</div>

<style>
	.panel {
		display: grid;
		gap: 18px;
		max-width: 640px;
		padding: 18px;
		border: 1px solid var(--border);
		border-radius: var(--radius-l);
		background: var(--surface);
	}
	@media (max-width: 420px) {
		.panel {
			padding: 14px;
		}
	}
	.scope-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 8px;
	}
	.grow {
		flex: 1 1 220px;
		min-width: 0;
	}
	.move-form {
		display: grid;
		gap: 14px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
