<script lang="ts">
	import EventForm from '#lib/ui/calendar/EventForm.svelte';
	import PageHeader from '#lib/ui/kit/PageHeader.svelte';

	let { data, form } = $props();
	const errors = $derived((form?.errors ?? {}) as Record<string, string | undefined>);
</script>

<PageHeader title="New event" description="Times are in {data.clock.zoneLabel}." />

<EventForm
	action="?/create"
	values={form?.values ?? data.initial}
	{errors}
	formError={errors.form ?? null}
	projects={data.projects}
	users={data.users}
	zoneLabel={data.clock.zoneLabel}
	submitLabel="Create event"
	cancelHref="/calendar"
/>
