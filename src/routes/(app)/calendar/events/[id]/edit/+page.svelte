<script lang="ts">
	import EventForm from '#lib/ui/calendar/EventForm.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';

	let { data, form } = $props();
	const errors = $derived((form?.errors ?? {}) as Record<string, string | undefined>);
	const conflict = $derived(form && 'conflict' in form && form.conflict);
	// After a refusal the form keeps the version it was loaded from; after "changed meanwhile" the user reloads.
	const expected = $derived(
		form && 'expected' in form ? (form.expected as number) : data.updatedAt
	);
</script>

<PageHeader
	title="Edit event"
	description="Changes apply to the whole series. Times are in {data.clock.zoneLabel}."
/>

{#if conflict}
	<p class="reload">
		<Button href="/calendar/events/{data.id}/edit">Reload to see the latest</Button>
	</p>
{/if}

<EventForm
	action="?/update"
	values={form?.values ?? data.initial}
	{errors}
	formError={errors.form ?? null}
	projects={data.projects}
	users={data.users}
	zoneLabel={data.clock.zoneLabel}
	expectedUpdatedAt={expected}
	submitLabel="Save event"
	cancelHref="/calendar/events/{data.id}"
/>

<style>
	.reload {
		margin: 0 0 12px;
	}
</style>
