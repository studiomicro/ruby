import { EMPLOYMENT_TYPE_LABELS } from '#lib/shared/enums';
import type { EmployeeRow } from './repo';

/**
 * HR's directory export: tier 0 and tier 1 columns only, never tier 2 or salary. Every cell is quoted, and one that
 * a spreadsheet would run as a formula (starting with =, +, -, @, tab or CR) is prefixed with `'`.
 */

const BOM = String.fromCharCode(0xfeff);

const HEADER = [
	'Employee number',
	'Full name',
	'Preferred name',
	'Job title',
	'Department',
	'Location',
	'Work e-mail',
	'Work phone',
	'Manager',
	'Employment type',
	'Status',
	'Start date',
	'Probation ends',
	'End date'
];

export function csvCell(value: string | null | undefined): string {
	let s = value ?? '';
	if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return `"${s.replace(/"/g, '""')}"`;
}

export function buildDirectoryCsv(rows: readonly EmployeeRow[]): string {
	const lines = [HEADER.map(csvCell).join(',')];
	for (const r of rows)
		lines.push(
			[
				r.employeeNo,
				r.fullName,
				r.preferredName,
				r.jobTitle,
				r.department,
				r.location,
				r.workEmail,
				r.workPhone,
				r.managerName,
				EMPLOYMENT_TYPE_LABELS[r.employmentType],
				r.status === 'active' ? 'Active' : 'Terminated',
				r.startOn,
				r.probationEndsOn,
				r.endOn
			]
				.map(csvCell)
				.join(',')
		);
	// A BOM so spreadsheet apps read UTF-8 names correctly; CRLF per RFC 4180.
	return `${BOM}${lines.join('\r\n')}\r\n`;
}
