<!--
	WorkFields: the work and employment inputs of an employee (create and HR edit share them). Names match the
	server parser (hr/validation.ts › parseWork); values are strings, errors per field.
-->
<script lang="ts">
	import { EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABELS } from '#lib/shared/enums';
	import Select from '#lib/ui/kit/Select.svelte';
	import TextField from '#lib/ui/kit/TextField.svelte';

	let {
		values,
		errors,
		managers
	}: {
		values: Record<string, string | null | undefined>;
		errors: Record<string, string | undefined>;
		managers: readonly { id: string; name: string }[];
	} = $props();

	const typeOptions = EMPLOYMENT_TYPES.map((t) => ({ value: t, label: EMPLOYMENT_TYPE_LABELS[t] }));
	const managerOptions = $derived([
		{ value: '', label: 'No manager' },
		...managers.map((m) => ({ value: m.id, label: m.name }))
	]);
	const v = (k: string) => values[k] ?? '';
</script>

<fieldset>
	<legend>Work</legend>
	<div class="grid">
		<TextField
			label="Full name"
			name="fullName"
			required
			maxlength={100}
			value={v('fullName')}
			error={errors.fullName}
			autocomplete="off"
		/>
		<TextField
			label="Preferred name"
			name="preferredName"
			maxlength={60}
			value={v('preferredName')}
			error={errors.preferredName}
		/>
		<TextField
			label="Job title"
			name="jobTitle"
			maxlength={100}
			value={v('jobTitle')}
			error={errors.jobTitle}
		/>
		<TextField
			label="Department"
			name="department"
			maxlength={80}
			value={v('department')}
			error={errors.department}
		/>
		<TextField
			label="Location"
			name="location"
			maxlength={80}
			value={v('location')}
			error={errors.location}
		/>
		<Select
			label="Manager"
			name="managerId"
			options={managerOptions}
			value={v('managerId')}
			error={errors.managerId}
		/>
		<TextField
			label="Work e-mail"
			name="workEmail"
			type="email"
			maxlength={254}
			value={v('workEmail')}
			error={errors.workEmail}
			autocomplete="off"
		/>
		<TextField
			label="Work phone"
			name="workPhone"
			inputmode="tel"
			maxlength={20}
			value={v('workPhone')}
			error={errors.workPhone}
		/>
	</div>
</fieldset>
<fieldset>
	<legend>Employment</legend>
	<div class="grid">
		<TextField
			label="Employee number"
			name="employeeNo"
			maxlength={20}
			value={v('employeeNo')}
			error={errors.employeeNo}
		/>
		<Select
			label="Employment type"
			name="employmentType"
			options={typeOptions}
			value={v('employmentType') || 'permanent'}
			error={errors.employmentType}
		/>
		<TextField
			label="Start date"
			name="startOn"
			type="date"
			value={v('startOn')}
			error={errors.startOn}
		/>
		<TextField
			label="Probation ends"
			name="probationEndsOn"
			type="date"
			value={v('probationEndsOn')}
			error={errors.probationEndsOn}
		/>
	</div>
</fieldset>

<style>
	fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 10px;
		padding: 0;
		font-size: 14px;
		font-weight: 600;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
	}
	@media (min-width: 640px) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
