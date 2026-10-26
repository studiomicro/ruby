import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { LAST4_FIELDS, SENSITIVE_FIELDS, SENSITIVE_FIELD_LABELS } from '#lib/shared/enums';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { readFormBody, textField } from '#lib/server/forms';
import { hrKey, KEY_NOT_CONFIGURED, requireViewer } from '#lib/server/hr/access';
import {
	addContact,
	getEmployee,
	listCompensation,
	listContacts,
	privateSummary,
	removeContact,
	updatePrivate,
	updateWork
} from '#lib/server/hr/repo';
import { formatIdr, isRevealField, mayReveal, revealField } from '#lib/server/hr/reveal';
import {
	HR_LIMITS,
	isUuid,
	parseContact,
	parseExpected,
	parsePrivate,
	parseSelfWork,
	SELF_PRIVATE_FIELDS
} from '#lib/server/hr/validation';
import { maskLast4, viewerAccess } from '#lib/server/hr/visibility';
import { getEnv } from '#lib/server/env';
import { todayIn } from '#lib/server/tasks/dates';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

const NOT_FOUND = 'Employee not found.';
const CHANGED = 'This profile was changed meanwhile. The page now shows the current version.';
const REVEAL_MAX = 30;

/**
 * The profile, built per viewer (roadmap 4.2): a section the viewer may not see is not in the payload at all.
 * Tier 2 and tier 3 values are never loaded: only whether they are set and their masked form.
 */
async function profile(event: Pick<RequestEvent, 'locals' | 'params'>) {
	const { user, viewer } = await requireViewer(event);
	const id = event.params.id ?? '';
	if (!isUuid(id)) error(404, NOT_FOUND);
	const employee = await getEmployee(event.locals.db, id.toLowerCase());
	if (!employee) error(404, NOT_FOUND);
	const access = viewerAccess(viewer, employee);
	if (!access.visible) error(404, NOT_FOUND);
	return { user, viewer, employee, access };
}

export const load: PageServerLoad = async (event) => {
	const { employee: e, access } = await profile(event);
	const db = event.locals.db;
	const key = await hrKey();
	const [summary, contacts, compensation] = await Promise.all([
		access.tier2 ? privateSummary(db, e.id) : null,
		access.tier2 ? listContacts(db, e.id) : null,
		access.tier3 ? listCompensation(db, e.id) : null
	]);
	return {
		employee: {
			id: e.id,
			fullName: e.fullName,
			preferredName: e.preferredName,
			jobTitle: e.jobTitle,
			department: e.department,
			location: e.location,
			workEmail: e.workEmail,
			workPhone: e.workPhone,
			managerId: e.managerName ? e.managerId : null,
			managerName: e.managerName,
			updatedAt: e.updatedAt
		},
		access: {
			self: access.self,
			manager: access.manager,
			hr: access.hr,
			tier1: access.tier1,
			tier2: access.tier2,
			tier3: access.tier3
		},
		employment: access.tier1
			? {
					status: e.status,
					employeeNo: e.employeeNo,
					employmentType: e.employmentType,
					startOn: e.startOn,
					probationEndsOn: e.probationEndsOn,
					endOn: e.endOn
				}
			: null,
		hrInfo: access.hr
			? {
					deleted: e.deletedAt !== null,
					linkedUserName: e.linkedUserName,
					linkedUserActive: e.linkedUserStatus === 'active'
				}
			: null,
		personal: summary
			? {
					updatedAt: summary.updatedAt,
					bankName: summary.bankName,
					fields: SENSITIVE_FIELDS.map((field) => ({
						field,
						label: SENSITIVE_FIELD_LABELS[field],
						set: summary.set[field],
						masked: (LAST4_FIELDS as readonly string[]).includes(field)
							? maskLast4(summary.last4[field as (typeof LAST4_FIELDS)[number]])
							: 'Hidden'
					}))
				}
			: null,
		contacts,
		compensation,
		keyReady: key !== null,
		contactsMax: HR_LIMITS.contactsMax,
		today: todayIn(getEnv().TEAM_TIME_ZONE, now())
	};
};

/** The profile for a write: only its own employee (self), or HR for the contact actions. */
async function writable(event: RequestEvent, who: 'self' | 'self-or-hr') {
	const found = await profile(event);
	const allowed = who === 'self' ? found.access.self : found.access.self || found.access.hr;
	if (!allowed || found.employee.deletedAt !== null) error(404, NOT_FOUND);
	return found;
}

export const actions: Actions = {
	/**
	 * One sensitive value, after the throttle, the tier rule and its audit row (PRD › Reveal flow). Others get the
	 * same 404 as a missing employee; the value is only in this response, which is never cached.
	 */
	reveal: async (event) => {
		const { user } = await requireViewer(event);
		const form = await readFormBody(event.request);
		const field = textField(form, 'field');
		const ref = textField(form, 'ref').trim().toLowerCase();
		if (!isRevealField(field) || (ref && !isUuid(ref)))
			return fail(400, { revealError: 'Unknown field.' });
		const { employee, access } = await profile(event);
		if (!mayReveal(access, field)) error(404, NOT_FOUND);
		const db = event.locals.db;
		const at = now();
		if (await overUserAttemptLimit(db, user.id, at, 'hr-reveal', REVEAL_MAX))
			return fail(429, { revealError: 'Too many reveals. Wait a few minutes.' });
		const key = await hrKey();
		if (!key) return fail(503, { revealError: KEY_NOT_CONFIGURED });
		const result = await revealField(db, key, user.id, employee.id, field, ref || null, at);
		event.setHeaders({ 'cache-control': 'no-store' });
		if (!result.ok) {
			if (result.reason === 'empty') return fail(400, { revealError: 'Nothing is stored there.' });
			if (result.reason === 'audit_failed')
				return fail(503, { revealError: 'Revealing is unavailable right now. Try again.' });
			return fail(500, { revealError: 'This value cannot be read with the current key.' });
		}
		const value = field === 'compensation_amount' ? formatIdr(result.value) : result.value;
		return { revealed: { field, ref, value } };
	},

	/** Own preferred name and work phone (owner decision 7); any other posted field is ignored. */
	updateSelf: async (event) => {
		const { user, employee } = await writable(event, 'self');
		const form = await readFormBody(event.request, HR_LIMITS.formBodyMax);
		const expected = parseExpected(textField(form, 'expectedUpdatedAt'));
		if (expected === null) return fail(400, { selfErrors: { form: CHANGED } });
		const parsed = parseSelfWork(form);
		if (!parsed.ok) return fail(400, { selfErrors: parsed.errors, selfValues: parsed.echo });
		const result = await updateWork(
			event.locals.db,
			user.id,
			employee,
			parsed.value,
			expected,
			now()
		);
		if (result.ok) return { selfSaved: 'Saved.' };
		if (result.reason === 'not_found') error(404, NOT_FOUND);
		if (result.reason === 'conflict') return fail(409, { selfErrors: { form: CHANGED } });
		return fail(400, { selfErrors: result.errors, selfValues: parsed.value });
	},

	/** Own personal phone and home address (tier 2, encrypted; blank keeps the stored value). */
	updateSelfPersonal: async (event) => {
		const { user, employee } = await writable(event, 'self');
		const key = await hrKey();
		if (!key) return fail(503, { personalErrors: { form: KEY_NOT_CONFIGURED } });
		const form = await readFormBody(event.request, HR_LIMITS.formBodyMax);
		const expected = parseExpected(textField(form, 'expectedUpdatedAt'));
		if (expected === null) return fail(400, { personalErrors: { form: CHANGED } });
		const at = now();
		const parsed = parsePrivate(form, SELF_PRIVATE_FIELDS, todayIn(getEnv().TEAM_TIME_ZONE, at));
		if (!parsed.ok) return fail(400, { personalErrors: parsed.errors });
		const result = await updatePrivate(
			event.locals.db,
			key,
			user.id,
			employee.id,
			parsed.changes,
			expected,
			at
		);
		if (result.ok) return { personalSaved: 'Saved.' };
		if (result.reason === 'not_found') error(404, NOT_FOUND);
		return fail(409, { personalErrors: { form: CHANGED } });
	},

	addContact: async (event) => {
		const { user, employee } = await writable(event, 'self-or-hr');
		const key = await hrKey();
		if (!key) return fail(503, { contactErrors: { form: KEY_NOT_CONFIGURED } });
		const form = await readFormBody(event.request, HR_LIMITS.formBodyMax);
		const parsed = parseContact(form);
		if (!parsed.ok) return fail(400, { contactErrors: parsed.errors, contactValues: parsed.echo });
		const result = await addContact(
			event.locals.db,
			key,
			user.id,
			employee.id,
			parsed.value,
			now()
		);
		if (result.ok) return { contactSaved: 'Contact added.' };
		if (result.reason === 'not_found') error(404, NOT_FOUND);
		return fail(400, {
			contactErrors: { form: `At most ${HR_LIMITS.contactsMax} emergency contacts.` }
		});
	},

	removeContact: async (event) => {
		const { user, employee } = await writable(event, 'self-or-hr');
		const form = await readFormBody(event.request);
		const contactId = textField(form, 'contactId').trim().toLowerCase();
		if (!isUuid(contactId)) return fail(400, { contactErrors: { form: 'Unknown contact.' } });
		const result = await removeContact(event.locals.db, user.id, employee.id, contactId, now());
		if (!result.ok)
			return fail(404, { contactErrors: { form: 'That contact was already removed.' } });
		return { contactSaved: 'Contact removed.' };
	}
};
