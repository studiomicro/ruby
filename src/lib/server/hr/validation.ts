import {
	EMPLOYMENT_TYPES,
	SENSITIVE_FIELDS,
	type EmploymentType,
	type SensitiveField
} from '#lib/shared/enums';
import { isPlausibleEmail, normalizeEmail } from '../auth/password';
import { checkboxField, oneOfField, textField } from '../forms';
import { isCalendarDate } from '../tasks/dates';
import { cleanBody, cleanLine, isUuid, parseExpected } from '../tasks/validation';

/**
 * Server-side validation of every RB-05 form and query (plain functions, as in tasks/validation.ts; no validation
 * library). Only length and digit checks for identifiers, never checksums: formats change and must not lock a record.
 */
export const HR_LIMITS = {
	fullName: 100,
	preferredName: 60,
	jobTitle: 100,
	department: 80,
	location: 80,
	homeAddress: 500,
	bankName: 60,
	bankHolder: 100,
	contactName: 100,
	relationship: 40,
	/** Live emergency contacts per employee. */
	contactsMax: 3,
	compensationNote: 200,
	/** Whole rupiah: up to 999 999 999 999. */
	amountDigitsMax: 12,
	/** Directory search text. */
	q: 50,
	pageSize: 50,
	pageMax: 10_000,
	/** Live employees the org chart and the export read at most. */
	orgMax: 1_000,
	auditPageSize: 50,
	/** Form bodies of the HR forms (a 500-character address URL-encoded fits many times). */
	formBodyMax: 16 * 1024
} as const;

export const DATE_MIN = '1970-01-01';
export const DATE_MAX = '2100-12-31';
const BIRTH_MIN = '1900-01-01';
/** Youngest age a birth date may give. */
const MIN_AGE_YEARS = 14;

export { isUuid, parseExpected };

const PHONE_RE = /^[+0-9 ()-]{5,20}$/;
const EMPLOYEE_NO_RE = /^[A-Za-z0-9._-]{1,20}$/;
/** Format (Cf: zero-width, bidi), line and paragraph separators: removed from the multi-line address too. */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/gu;

export type Errors = Record<string, string>;
export type Parsed<T> =
	{ ok: true; value: T } | { ok: false; errors: Errors; echo: Record<string, string> };

const M = {
	required: 'Required.',
	tooLong: (max: number) => `At most ${max} characters.`,
	email: 'Enter a valid e-mail address.',
	phone: 'Use 5 to 20 digits, spaces, +, - or brackets.',
	date: 'Enter a real date (YYYY-MM-DD).',
	employeeNo: 'Use 1 to 20 letters, digits, dots, dashes or underscores.',
	employmentType: 'Choose an employment type.',
	manager: 'Choose a current employee.',
	beforeStart: 'Must not be before the start date.',
	birthDate: `Enter a real date at least ${MIN_AGE_YEARS} years ago.`,
	digits: (min: number, max: number) =>
		min === max ? `Enter exactly ${min} digits.` : `Enter ${min} to ${max} digits.`,
	npwp: 'Enter 15 or 16 digits.',
	amount: 'Enter a whole rupiah amount above 0.',
	confirm: 'Tick the box to confirm.'
} as const;
export const HR_MESSAGES = M;

/** A single-line optional value: null when empty, an error when over `max`. */
function optionalLine(raw: string, max: number, errors: Errors, key: string): string | null {
	const { value, tooLong } = cleanLine(raw, max);
	if (tooLong) errors[key] = M.tooLong(max);
	return value || null;
}

function optionalDate(raw: string, errors: Errors, key: string): string | null {
	const s = raw.trim();
	if (!s) return null;
	if (!isCalendarDate(s, DATE_MIN, DATE_MAX)) errors[key] = M.date;
	return s;
}

function optionalPhone(raw: string, errors: Errors, key: string): string | null {
	const s = raw.trim();
	if (!s) return null;
	if (!PHONE_RE.test(s)) errors[key] = M.phone;
	return s;
}

function optionalEmail(raw: string, errors: Errors, key: string): string | null {
	const s = normalizeEmail(raw);
	if (!s) return null;
	if (!isPlausibleEmail(s)) errors[key] = M.email;
	return s;
}

/** A multi-line value (the home address): CRLF to LF, control and invisible characters stripped, trimmed. */
export function cleanMultiline(raw: string, max: number): { value: string; tooLong: boolean } {
	const value = cleanBody(raw.slice(0, max * 4))
		.replace(INVISIBLE, '')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return { value, tooLong: Array.from(value).length > max };
}

/** Digits of an identifier (spaces, dots and dashes dropped), or null when they do not fit `min`..`max`. */
export function identifierDigits(raw: string, min: number, max: number): string | null {
	const digits = raw.replace(/[\s.-]/g, '');
	return /^\d+$/.test(digits) && digits.length >= min && digits.length <= max ? digits : null;
}

/** `YYYY-MM-DD` `years` before `today` (29 February falls back to 28). */
function yearsBefore(today: string, years: number): string {
	const y = Number(today.slice(0, 4)) - years;
	const md = today.slice(5) === '02-29' ? '02-28' : today.slice(5);
	return `${String(y).padStart(4, '0')}-${md}`;
}

// ── Work and employment (tier 0 and 1, HR) ─────────────────────────────────────────────────────────────────

export interface WorkFields {
	fullName: string;
	preferredName: string | null;
	jobTitle: string | null;
	department: string | null;
	location: string | null;
	workEmail: string | null;
	workPhone: string | null;
	employeeNo: string | null;
	employmentType: EmploymentType;
	startOn: string | null;
	probationEndsOn: string | null;
	managerId: string | null;
}
export type WorkField = keyof WorkFields;

/** Form names of the work fields (the form uses the same camelCase names). */
export const WORK_FIELDS: readonly WorkField[] = [
	'fullName',
	'preferredName',
	'jobTitle',
	'department',
	'location',
	'workEmail',
	'workPhone',
	'employeeNo',
	'employmentType',
	'startOn',
	'probationEndsOn',
	'managerId'
];

/** Audit names of the work fields (`snake_case`, as the columns). */
export const WORK_FIELD_COLUMNS: Record<WorkField, string> = {
	fullName: 'full_name',
	preferredName: 'preferred_name',
	jobTitle: 'job_title',
	department: 'department',
	location: 'location',
	workEmail: 'work_email',
	workPhone: 'work_phone',
	employeeNo: 'employee_no',
	employmentType: 'employment_type',
	startOn: 'start_on',
	probationEndsOn: 'probation_ends_on',
	managerId: 'manager_id'
};

const echoOf = (form: FormData, names: readonly string[]) =>
	Object.fromEntries(names.map((n) => [n, textField(form, n).slice(0, 600)]));

export function parseWork(form: FormData): Parsed<WorkFields> {
	const errors: Errors = {};
	const full = cleanLine(textField(form, 'fullName'), HR_LIMITS.fullName);
	if (full.tooLong) errors.fullName = M.tooLong(HR_LIMITS.fullName);
	else if (!full.value) errors.fullName = M.required;
	const employeeNoRaw = textField(form, 'employeeNo').trim();
	if (employeeNoRaw && !EMPLOYEE_NO_RE.test(employeeNoRaw)) errors.employeeNo = M.employeeNo;
	const employmentType = oneOfField(form, 'employmentType', EMPLOYMENT_TYPES);
	if (!employmentType) errors.employmentType = M.employmentType;
	const managerRaw = textField(form, 'managerId').trim();
	if (managerRaw && !isUuid(managerRaw)) errors.managerId = M.manager;
	const value: WorkFields = {
		fullName: full.value,
		preferredName: optionalLine(
			textField(form, 'preferredName'),
			HR_LIMITS.preferredName,
			errors,
			'preferredName'
		),
		jobTitle: optionalLine(textField(form, 'jobTitle'), HR_LIMITS.jobTitle, errors, 'jobTitle'),
		department: optionalLine(
			textField(form, 'department'),
			HR_LIMITS.department,
			errors,
			'department'
		),
		location: optionalLine(textField(form, 'location'), HR_LIMITS.location, errors, 'location'),
		workEmail: optionalEmail(textField(form, 'workEmail'), errors, 'workEmail'),
		workPhone: optionalPhone(textField(form, 'workPhone'), errors, 'workPhone'),
		employeeNo: employeeNoRaw || null,
		employmentType: employmentType ?? 'permanent',
		startOn: optionalDate(textField(form, 'startOn'), errors, 'startOn'),
		probationEndsOn: optionalDate(textField(form, 'probationEndsOn'), errors, 'probationEndsOn'),
		managerId: managerRaw ? managerRaw.toLowerCase() : null
	};
	if (
		value.startOn &&
		value.probationEndsOn &&
		!errors.startOn &&
		!errors.probationEndsOn &&
		value.probationEndsOn < value.startOn
	)
		errors.probationEndsOn = M.beforeStart;
	if (Object.keys(errors).length) return { ok: false, errors, echo: echoOf(form, WORK_FIELDS) };
	return { ok: true, value };
}

// ── Sensitive fields (tier 2) ──────────────────────────────────────────────────────────────────────────────

/** Tier 2 values that are kept in plain text (shown to self and HR, never to others). */
export type PlainPrivateField = 'bank_name';
export type PrivateField = SensitiveField | PlainPrivateField;
export const PRIVATE_FIELDS: readonly PrivateField[] = [...SENSITIVE_FIELDS, 'bank_name'];

/** What a sensitive form changes: a new value, or null to clear it. Fields left blank are not in the map. */
export type PrivateChanges = Partial<Record<PrivateField, string | null>>;

function checkPrivate(field: PrivateField, raw: string, today: string): string | { error: string } {
	switch (field) {
		case 'birth_date': {
			const s = raw.trim();
			return isCalendarDate(s, BIRTH_MIN, yearsBefore(today, MIN_AGE_YEARS))
				? s
				: { error: M.birthDate };
		}
		case 'home_address': {
			const { value, tooLong } = cleanMultiline(raw, HR_LIMITS.homeAddress);
			return tooLong ? { error: M.tooLong(HR_LIMITS.homeAddress) } : value;
		}
		case 'personal_phone': {
			const s = raw.trim();
			return PHONE_RE.test(s) ? s : { error: M.phone };
		}
		case 'personal_email': {
			const s = normalizeEmail(raw);
			return isPlausibleEmail(s) ? s : { error: M.email };
		}
		case 'nik':
			return identifierDigits(raw, 16, 16) ?? { error: M.digits(16, 16) };
		case 'npwp':
			return identifierDigits(raw, 15, 16) ?? { error: M.npwp };
		case 'bpjs_kes':
		case 'bpjs_tk':
			return identifierDigits(raw, 8, 20) ?? { error: M.digits(8, 20) };
		case 'bank_account':
			return identifierDigits(raw, 5, 30) ?? { error: M.digits(5, 30) };
		case 'bank_holder':
		case 'bank_name': {
			const max = field === 'bank_name' ? HR_LIMITS.bankName : HR_LIMITS.bankHolder;
			const { value, tooLong } = cleanLine(raw, max);
			return tooLong ? { error: M.tooLong(max) } : value;
		}
	}
}

/**
 * The tier 2 changes a form asks for, limited to `allowed`: a blank input keeps the stored value (stored values are
 * never sent back to the browser), `clear_<field>` = `on` removes it. `today` is the team's date (birth-date floor).
 */
export function parsePrivate(
	form: FormData,
	allowed: readonly PrivateField[],
	today: string
): { ok: true; changes: PrivateChanges } | { ok: false; errors: Errors } {
	const errors: Errors = {};
	const changes: PrivateChanges = {};
	for (const field of allowed) {
		if (checkboxField(form, `clear_${field}`)) {
			changes[field] = null;
			continue;
		}
		const raw = textField(form, field);
		if (!raw.trim()) continue;
		const checked = checkPrivate(field, raw, today);
		if (typeof checked === 'string') {
			if (checked) changes[field] = checked;
		} else errors[field] = checked.error;
	}
	return Object.keys(errors).length ? { ok: false, errors } : { ok: true, changes };
}

/** The four last digits kept next to an identifier's ciphertext. */
export const last4 = (digits: string): string => digits.slice(-4);

// ── Self-service (the employee's own record) ───────────────────────────────────────────────────────────────

/** Own tier 0 fields an employee may change (owner decision 7). */
export function parseSelfWork(
	form: FormData
): Parsed<{ preferredName: string | null; workPhone: string | null }> {
	const errors: Errors = {};
	const value = {
		preferredName: optionalLine(
			textField(form, 'preferredName'),
			HR_LIMITS.preferredName,
			errors,
			'preferredName'
		),
		workPhone: optionalPhone(textField(form, 'workPhone'), errors, 'workPhone')
	};
	if (Object.keys(errors).length)
		return { ok: false, errors, echo: echoOf(form, ['preferredName', 'workPhone']) };
	return { ok: true, value };
}

/** Own tier 2 fields an employee may change (owner decision 7); the rest stay HR-only. */
export const SELF_PRIVATE_FIELDS: readonly PrivateField[] = ['personal_phone', 'home_address'];

// ── Emergency contacts, salary records, termination ────────────────────────────────────────────────────────

export interface ContactInput {
	name: string;
	relationship: string;
	phone: string;
}

export function parseContact(form: FormData): Parsed<ContactInput> {
	const errors: Errors = {};
	const name = cleanLine(textField(form, 'contactName'), HR_LIMITS.contactName);
	if (name.tooLong) errors.contactName = M.tooLong(HR_LIMITS.contactName);
	else if (!name.value) errors.contactName = M.required;
	const relationship = cleanLine(textField(form, 'relationship'), HR_LIMITS.relationship);
	if (relationship.tooLong) errors.relationship = M.tooLong(HR_LIMITS.relationship);
	else if (!relationship.value) errors.relationship = M.required;
	const phone = textField(form, 'contactPhone').trim();
	if (!phone) errors.contactPhone = M.required;
	else if (!PHONE_RE.test(phone)) errors.contactPhone = M.phone;
	if (Object.keys(errors).length)
		return { ok: false, errors, echo: { relationship: relationship.value } };
	return { ok: true, value: { name: name.value, relationship: relationship.value, phone } };
}

export interface CompensationInput {
	effectiveOn: string;
	/** Minor units (sen): whole rupiah × 100. */
	amountMinor: number;
	note: string | null;
}

export function parseCompensation(form: FormData): Parsed<CompensationInput> {
	const errors: Errors = {};
	const effectiveOn = textField(form, 'effectiveOn').trim();
	if (!isCalendarDate(effectiveOn, DATE_MIN, DATE_MAX)) errors.effectiveOn = M.date;
	const digits = textField(form, 'amount').replace(/[\s.,]/g, '');
	const rupiah =
		/^\d+$/.test(digits) && digits.length <= HR_LIMITS.amountDigitsMax ? Number(digits) : 0;
	if (!(rupiah > 0)) errors.amount = M.amount;
	const note = optionalLine(textField(form, 'note'), HR_LIMITS.compensationNote, errors, 'note');
	if (Object.keys(errors).length)
		return { ok: false, errors, echo: { effectiveOn, note: note ?? '' } };
	return { ok: true, value: { effectiveOn, amountMinor: rupiah * 100, note } };
}

export function parseTerminate(form: FormData, startOn: string | null): Parsed<{ endOn: string }> {
	const errors: Errors = {};
	const endOn = textField(form, 'endOn').trim();
	if (!isCalendarDate(endOn, DATE_MIN, DATE_MAX)) errors.endOn = M.date;
	else if (startOn && endOn < startOn) errors.endOn = M.beforeStart;
	if (!checkboxField(form, 'confirm')) errors.confirm = M.confirm;
	if (Object.keys(errors).length) return { ok: false, errors, echo: { endOn } };
	return { ok: true, value: { endOn } };
}

// ── Directory query ────────────────────────────────────────────────────────────────────────────────────────

export const DIRECTORY_STATUSES = ['active', 'terminated', 'all', 'deleted'] as const;
export type DirectoryStatus = (typeof DIRECTORY_STATUSES)[number];

export interface DirectoryQuery {
	q: string;
	department: string | null;
	status: DirectoryStatus;
	sort: 'name' | 'department';
	page: number;
}

/**
 * The directory's URL query; null when `q` is longer than HR_LIMITS.q (the route answers 400). Unknown values fall
 * back to defaults; `status` other than `active` is honoured only for HR (`isHr`).
 */
export function parseDirectoryQuery(params: URLSearchParams, isHr: boolean): DirectoryQuery | null {
	const qRaw = params.get('q') ?? '';
	if (Array.from(qRaw).length > HR_LIMITS.q) return null;
	const q = cleanLine(qRaw, HR_LIMITS.q).value;
	const department = cleanLine(params.get('department') ?? '', HR_LIMITS.department).value || null;
	const statusRaw = params.get('status') ?? 'active';
	const status =
		isHr && (DIRECTORY_STATUSES as readonly string[]).includes(statusRaw)
			? (statusRaw as DirectoryStatus)
			: 'active';
	const sort = params.get('sort') === 'department' ? 'department' : 'name';
	const pageRaw = params.get('page') ?? '1';
	const n = /^\d{1,5}$/.test(pageRaw) ? Number(pageRaw) : 1;
	const page = Math.min(Math.max(n, 1), HR_LIMITS.pageMax);
	return { q, department, status, sort, page };
}
