import { LIMITS, cleanBody, cleanLine, isUuid, parseExpected } from '../tasks/validation';
import { textField } from '../forms';

/**
 * Project form validation. The key is typed in either case, stored upper case, and fixed once created. Keys that a
 * static route under /projects already uses are reserved.
 */
const KEY_INPUT_RE = /^[A-Za-z][A-Za-z0-9]{1,9}$/;
export const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const RESERVED_KEYS = new Set(['NEW']);

export const PROJECT_MESSAGES = {
	key: 'Use 2 to 10 letters or digits, starting with a letter (for example OPS).',
	keyReserved: 'That key is reserved. Choose another.',
	keyTaken: 'That key is already used',
	nameRequired: 'Enter a name.',
	nameTooLong: `Keep the name to ${LIMITS.projectNameMax} characters.`,
	descriptionTooLong: `Keep the description to ${LIMITS.projectDescriptionMax.toLocaleString('en-US')} characters.`,
	lead: 'Choose an active teammate or nobody.'
} as const;

/** The stored form of a key typed by a user, or null when it is not a valid key. */
export function normaliseKey(input: string): string | null {
	const trimmed = input.trim();
	return KEY_INPUT_RE.test(trimmed) ? trimmed.toUpperCase() : null;
}

export interface ProjectFields {
	name: string;
	description: string;
	leadId: string | null;
}
type Errors = Partial<Record<'key' | 'name' | 'description' | 'leadId' | 'form', string>>;

function parseFields(form: FormData): { value: ProjectFields; errors: Errors } {
	const errors: Errors = {};
	const name = cleanLine(textField(form, 'name'), LIMITS.projectNameMax);
	if (!name.value) errors.name = PROJECT_MESSAGES.nameRequired;
	else if (name.tooLong) errors.name = PROJECT_MESSAGES.nameTooLong;
	const description = cleanBody(textField(form, 'description'));
	if (description.length > LIMITS.projectDescriptionMax)
		errors.description = PROJECT_MESSAGES.descriptionTooLong;
	const lead = textField(form, 'leadId').trim();
	if (lead !== '' && !isUuid(lead)) errors.leadId = PROJECT_MESSAGES.lead;
	return {
		value: { name: name.value, description, leadId: lead === '' ? null : lead.toLowerCase() },
		errors
	};
}

export function parseProjectCreate(
	form: FormData
):
	| { ok: true; value: ProjectFields & { key: string } }
	| { ok: false; errors: Errors; echo: Record<string, string> } {
	const { value, errors } = parseFields(form);
	const key = normaliseKey(textField(form, 'key'));
	if (!key) errors.key = PROJECT_MESSAGES.key;
	else if (RESERVED_KEYS.has(key)) errors.key = PROJECT_MESSAGES.keyReserved;
	if (!key || Object.keys(errors).length > 0)
		return { ok: false, errors, echo: echoOf(form, ['key', 'name', 'description', 'leadId']) };
	return { ok: true, value: { ...value, key } };
}

/** The edit form: name, description, lead and `expectedUpdatedAt`. A posted `key` is ignored (keys are fixed). */
export function parseProjectEdit(
	form: FormData
):
	| { ok: true; value: ProjectFields; expected: number }
	| { ok: false; errors: Errors; echo: Record<string, string> } {
	const { value, errors } = parseFields(form);
	const expected = parseExpected(textField(form, 'expectedUpdatedAt'));
	if (expected === null) errors.form = 'Reload the page and try again.';
	if (expected === null || Object.keys(errors).length > 0)
		return { ok: false, errors, echo: echoOf(form, ['name', 'description', 'leadId']) };
	return { ok: true, value, expected };
}

/** What the user typed, sent back so a refused no-JS form keeps it (capped: never a megabyte echo). */
function echoOf(form: FormData, names: string[]): Record<string, string> {
	return Object.fromEntries(names.map((n) => [n, textField(form, n).slice(0, 20_000)]));
}
