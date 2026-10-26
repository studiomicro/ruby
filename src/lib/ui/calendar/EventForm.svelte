<!--
	EventForm: create and edit an event (RB-09). Native date and time inputs in the team zone (no picker library),
	attendees as a checkbox list of active users, recurrence with a required end. Works without JavaScript (the time
	fields stay visible and are ignored for an all-day event); with it, the time fields hide for all-day events.
-->
<script lang="ts">
	import { enhance } from '#lib/ui/pwa/offline-form';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Card from '#lib/ui/kit/Card.svelte';
	import Checkbox from '#lib/ui/kit/Checkbox.svelte';
	import FieldError from '#lib/ui/kit/FieldError.svelte';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextArea from '#lib/ui/kit/TextArea.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	interface Values {
		title: string;
		description: string;
		location: string;
		allDay: boolean;
		startDate: string;
		startTime: string;
		endDate: string;
		endTime: string;
		projectId: string;
		visibility: string;
		attendees: string[];
		repeat: string;
		interval: string;
		ends: string;
		until: string;
		count: string;
	}

	let {
		action,
		values,
		errors = {},
		formError = null,
		projects,
		users,
		zoneLabel,
		expectedUpdatedAt,
		submitLabel,
		cancelHref
	}: {
		action: string;
		values: Values;
		errors?: Record<string, string | undefined>;
		formError?: string | null;
		projects: { id: string; key: string; name: string }[];
		users: { id: string; name: string }[];
		zoneLabel: string;
		expectedUpdatedAt?: number;
		submitLabel: string;
		cancelHref: string;
	} = $props();

	// The form's own state starts from the server's values (an echo after a refusal included).
	// svelte-ignore state_referenced_locally
	let allDay = $state(values.allDay);
	// svelte-ignore state_referenced_locally
	let repeat = $state(values.repeat || 'none');
	let saving = $state(false);

	const projectOptions = $derived([
		{ value: '', label: 'No project' },
		...projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))
	]);
	const chosen = $derived(new Set(values.attendees));
</script>

<div class="wrap">
	<Card>
		<form
			method="POST"
			{action}
			class="event-form"
			use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update({ reset: false });
					saving = false;
				};
			}}
		>
			{#if expectedUpdatedAt !== undefined}
				<input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
			{/if}
			<Banner tone="error" message={formError} />

			<TextField
				label="Title"
				name="title"
				required
				maxlength={120}
				value={values.title}
				error={errors.title}
			/>

			<Checkbox label="All day" name="allDay" bind:checked={allDay} />

			<fieldset class="when">
				<legend>Starts</legend>
				<div class="pair">
					<TextField
						label="Start date"
						name="startDate"
						type="date"
						required
						value={values.startDate}
						error={errors.start}
					/>
					{#if !allDay}
						<TextField
							label="Start time ({zoneLabel})"
							name="startTime"
							type="time"
							step={300}
							value={values.startTime}
						/>
					{/if}
				</div>
			</fieldset>
			<fieldset class="when">
				<legend>Ends</legend>
				<div class="pair">
					<TextField
						label="End date"
						name="endDate"
						type="date"
						value={values.endDate}
						error={errors.end}
					/>
					{#if !allDay}
						<TextField
							label="End time ({zoneLabel})"
							name="endTime"
							type="time"
							step={300}
							value={values.endTime}
						/>
					{/if}
				</div>
			</fieldset>

			<TextField
				label="Location"
				name="location"
				maxlength={200}
				value={values.location}
				error={errors.location}
			/>
			<TextArea
				label="Description"
				name="description"
				value={values.description}
				maxlength={5000}
				rows={5}
				hint="Markdown."
				error={errors.description}
			/>

			<div class="pair">
				<Select
					label="Project"
					name="projectId"
					options={projectOptions}
					value={values.projectId}
					error={errors.projectId}
				/>
				<Select
					label="Who can see it"
					name="visibility"
					options={[
						{ value: 'team', label: 'Team: everyone' },
						{ value: 'private', label: 'Private: me and attendees' }
					]}
					value={values.visibility || 'team'}
					error={errors.visibility}
				/>
			</div>

			<fieldset class="attendees" aria-describedby="attendees-error">
				<legend>Attendees</legend>
				<div class="people">
					{#each users as u (u.id)}
						<Checkbox label={u.name} name="attendees" value={u.id} checked={chosen.has(u.id)} />
					{/each}
				</div>
				<FieldError id="attendees-error" message={errors.attendees} />
			</fieldset>

			<fieldset class="repeat" aria-describedby="repeat-error">
				<legend>Repeat</legend>
				<div class="pair">
					<Select
						label="Repeats"
						name="repeat"
						bind:value={repeat}
						options={[
							{ value: 'none', label: 'Does not repeat' },
							{ value: 'daily', label: 'Daily' },
							{ value: 'weekly', label: 'Weekly (same weekday)' },
							{ value: 'monthly', label: 'Monthly (same day)' }
						]}
					/>
					<TextField
						label="Every (1–30)"
						name="interval"
						type="number"
						inputmode="numeric"
						value={values.interval || '1'}
					/>
				</div>
				{#if repeat !== 'none'}
					<div class="ends">
						<label class="check"
							><input type="radio" name="ends" value="until" checked={values.ends !== 'count'} /> Until</label
						>
						<TextField label="Last day" name="until" type="date" value={values.until} />
						<label class="check"
							><input type="radio" name="ends" value="count" checked={values.ends === 'count'} /> A number
							of times</label
						>
						<TextField
							label="Times (1–500)"
							name="count"
							type="number"
							inputmode="numeric"
							value={values.count}
						/>
					</div>
				{/if}
				<FieldError id="repeat-error" message={errors.repeat} />
			</fieldset>

			<div class="actions">
				<Button type="submit" variant="primary" loading={saving} loadingLabel="Saving…"
					>{submitLabel}</Button
				>
				<Button href={cancelHref} variant="ghost">Cancel</Button>
			</div>
		</form>
	</Card>
</div>

<style>
	.wrap {
		max-width: 760px;
		min-width: 0;
	}
	.event-form {
		display: grid;
		gap: 16px;
		min-width: 0;
	}
	fieldset {
		display: grid;
		gap: 8px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 6px;
		color: var(--fg-strong);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.pair {
		display: grid;
		gap: 10px;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		font-size: var(--text-base);
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.check input {
		flex: none;
		width: 18px;
		height: 18px;
		accent-color: var(--accent);
	}
	.people {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 180px), 1fr));
		gap: 0 12px;
		max-height: 240px;
		overflow-y: auto;
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-m);
		background: var(--control);
	}
	.ends {
		display: grid;
		gap: 6px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding-bottom: 8px;
	}
</style>
