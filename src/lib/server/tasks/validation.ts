import {
	TASK_PRIORITIES,
	TASK_STATUSES,
	TASK_TYPES,
	type TaskPriority,
	type TaskStatus,
	type TaskType
} from '#lib/shared/enums';
import { cleanText } from '#lib/shared/text';
import { isValidDueOn } from './dates';

/**
 * Server-side validation of every RB-01 form and query (the PRD's zod schemas, written as plain functions: the
 * project carries no validation library). Client hints (`maxlength`, `required`) mirror these; the server is the
 * rule. Every limit lives in LIMITS.
 */
export const LIMITS = {
	projectNameMax: 80,
	projectDescriptionMax: 5_000,
	titleMax: 200,
	descriptionMax: 20_000,
	/** Rows per list page. */
	pageSize: 50,
	pageMax: 10_000,
	/** Cards per board column; the rest are counted and linked to the filtered list. */
	boardColumnMax: 100,
	/** Open tasks My tasks reads at most. */
	myTasksMax: 500,
	/** Closed tasks `?closed=1` appends. */
	myTasksClosedMax: 50,
	/** Projects the list reads at most (one team). */
	projectListMax: 500,
	/** Body cap of forms that carry a description: 20 000 characters, URL-encoded, with room to spare. */
	formBodyMax: 256 * 1024,
	/** Attempts of a task create whose number collided. */
	createAttempts: 3
} as const;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

/** C0 controls except tab and newline, DEL and C1 controls: removed from multi-line Markdown bodies. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const BODY_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * A single-line value (title, name) cleaned by cleanText; `tooLong` when it has more than `max` code points, so
 * an over-long value is refused instead of silently cut.
 */
export function cleanLine(input: string, max: number): { value: string; tooLong: boolean } {
	const value = cleanText(input, max + 1);
	return Array.from(value).length > max
		? { value: Array.from(value).slice(0, max).join(''), tooLong: true }
		: { value, tooLong: false };
}

/** A multi-line Markdown body: CRLF to LF, control characters (except tab/newline) stripped, trimmed. */
export function cleanBody(input: string): string {
	return input.replace(/\r\n?/g, '\n').replace(BODY_CONTROLS, '').normalize('NFC').trim();
}

/** `expectedUpdatedAt` from a form: a non-negative safe integer, else null. */
export function parseExpected(raw: string): number | null {
	if (!/^\d{1,16}$/.test(raw)) return null;
	const n = Number(raw);
	return Number.isSafeInteger(n) ? n : null;
}

export type FieldErrors<K extends string> = Partial<Record<K | 'form', string>>;

export const MESSAGES = {
	titleRequired: 'Enter a title.',
	titleTooLong: `Keep the title to ${LIMITS.titleMax} characters.`,
	descriptionTooLong: `Keep the description to ${LIMITS.descriptionMax.toLocaleString('en-US')} characters.`,
	status: 'Choose a status.',
	priority: 'Choose a priority.',
	assignee: 'Choose an active teammate or nobody.',
	dueOn: 'Enter a date between 2000-01-01 and 2100-12-31.',
	milestone: 'Choose an open milestone of this project or none.',
	type: 'Choose a type.',
	stale: 'Reload the page and try again.',
	archived: 'Project is archived.',
	busy: 'Busy, try again.'
} as const;

export interface TaskFields {
	title: string;
	description: string;
	status: TaskStatus;
	priority: TaskPriority;
	assigneeId: string | null;
	dueOn: string | null;
	/** RB-08: a live milestone of the same project (open, or the closed one already assigned), or none. */
	milestoneId: string | null;
	/** RB-12: Task, Bug, Feature request or Improvement. */
	type: TaskType;
}
export type TaskField = keyof TaskFields;

type Parsed<T, K extends string> =
	{ ok: true; value: T } | { ok: false; errors: FieldErrors<K>; partial: Partial<T> };

const parseTitle = (raw: string) => {
	const { value, tooLong } = cleanLine(raw, LIMITS.titleMax);
	if (!value) return { value, error: MESSAGES.titleRequired };
	return { value, error: tooLong ? MESSAGES.titleTooLong : undefined };
};
const parseDescription = (raw: string) => {
	const value = cleanBody(raw);
	return {
		value,
		error: value.length > LIMITS.descriptionMax ? MESSAGES.descriptionTooLong : undefined
	};
};
const parseStatus = (raw: string) =>
	(TASK_STATUSES as readonly string[]).includes(raw)
		? { value: raw as TaskStatus }
		: { value: undefined, error: MESSAGES.status };
const parsePriority = (raw: string) =>
	(TASK_PRIORITIES as readonly string[]).includes(raw)
		? { value: raw as TaskPriority }
		: { value: undefined, error: MESSAGES.priority };
/** Syntax only: whether the id names an active user is checked against D1 by the repo. */
const parseAssignee = (raw: string) => {
	const v = raw.trim();
	if (v === '') return { value: null };
	return isUuid(v) ? { value: v.toLowerCase() } : { value: undefined, error: MESSAGES.assignee };
};
const parseDue = (raw: string) => {
	const v = raw.trim();
	if (v === '') return { value: null };
	return isValidDueOn(v) ? { value: v } : { value: undefined, error: MESSAGES.dueOn };
};

/** Syntax only: whether the id names a milestone the task may take is checked against D1 by the repo. */
const parseMilestone = (raw: string) => {
	const v = raw.trim();
	if (v === '') return { value: null };
	return isUuid(v) ? { value: v.toLowerCase() } : { value: undefined, error: MESSAGES.milestone };
};

const parseType = (raw: string) =>
	(TASK_TYPES as readonly string[]).includes(raw)
		? { value: raw as TaskType }
		: { value: undefined, error: MESSAGES.type };

const PARSERS: {
	[K in TaskField]: (raw: string) => { value: TaskFields[K] | undefined; error?: string };
} = {
	title: parseTitle,
	description: parseDescription,
	status: parseStatus,
	priority: parsePriority,
	assigneeId: parseAssignee,
	dueOn: parseDue,
	milestoneId: parseMilestone,
	type: parseType
};
export const TASK_FIELDS = Object.keys(PARSERS) as TaskField[];

/**
 * The task fields of a create or full-edit form. A field missing from the form takes its value from `fallback`
 * (the stored task on edit; the defaults on create), so an edit form that shows only title and description keeps
 * the other fields as stored.
 */
export function parseTaskFields(
	form: FormData,
	fallback: TaskFields
): Parsed<TaskFields, TaskField> {
	const out: Partial<TaskFields> = {};
	const errors: FieldErrors<TaskField> = {};
	for (const field of TASK_FIELDS) {
		const raw = form.get(field);
		if (typeof raw !== 'string') {
			(out as Record<string, unknown>)[field] = fallback[field];
			continue;
		}
		const { value, error } = PARSERS[field](raw);
		if (error) errors[field] = error;
		else (out as Record<string, unknown>)[field] = value;
	}
	if (Object.keys(errors).length > 0) return { ok: false, errors, partial: out };
	return { ok: true, value: out as TaskFields };
}

/** One field of a `patch` form: `field` names it, `value` carries it. */
export function parsePatch(
	form: FormData
):
	| { ok: true; field: TaskField; value: TaskFields[TaskField] }
	| { ok: false; field: TaskField | null; error: string } {
	const field = form.get('field');
	if (typeof field !== 'string' || !(TASK_FIELDS as string[]).includes(field))
		return { ok: false, field: null, error: 'Unknown field.' };
	const f = field as TaskField;
	const raw = form.get('value');
	const { value, error } = PARSERS[f](typeof raw === 'string' ? raw : '');
	if (error || value === undefined) return { ok: false, field: f, error: error ?? MESSAGES.stale };
	return { ok: true, field: f, value };
}

// ── Board moves ─────────────────────────────────────────────────────────────────────────────────────────────

/** Where a moved card lands: after a given card (null: top of the column) or at one end. */
export type Placement = { after: string | null } | { place: 'top' | 'bottom' };

/** A move: `status` plus exactly one of `afterTaskId` (a task id, or empty for the top) and `place`. */
export function parseMove(
	form: FormData
):
	| { ok: true; taskId: string; status: TaskStatus; placement: Placement }
	| { ok: false; error: string } {
	const taskId = form.get('taskId');
	const status = form.get('status');
	if (typeof taskId !== 'string' || !isUuid(taskId)) return { ok: false, error: 'Unknown task.' };
	if (typeof status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(status))
		return { ok: false, error: MESSAGES.status };
	const after = form.get('afterTaskId');
	const place = form.get('place');
	if ((typeof after === 'string') === (typeof place === 'string'))
		return { ok: false, error: 'Choose where to put the task.' };
	let placement: Placement;
	if (typeof after === 'string') {
		if (after !== '' && !isUuid(after)) return { ok: false, error: 'Unknown task.' };
		placement = { after: after === '' ? null : after.toLowerCase() };
	} else if (place === 'top' || place === 'bottom') {
		placement = { place };
	} else {
		return { ok: false, error: 'Choose where to put the task.' };
	}
	return { ok: true, taskId: taskId.toLowerCase(), status: status as TaskStatus, placement };
}

// ── List filters (query string) ─────────────────────────────────────────────────────────────────────────────

export const TASK_SORTS = ['number', 'priority', 'due', 'updated'] as const;
export type TaskSort = (typeof TASK_SORTS)[number];
export const SORT_DIRS = ['asc', 'desc'] as const;
export type SortDir = (typeof SORT_DIRS)[number];

/** Assignee filter: anyone, the viewer, nobody, or one user id. */
export type AssigneeFilter = 'any' | 'me' | 'none' | { userId: string };

export interface TaskFilters {
	/** Empty: every status. */
	statuses: TaskStatus[];
	/** Empty: every priority. */
	priorities: TaskPriority[];
	assignee: AssigneeFilter;
	/** RB-08: label ids (OR inside the set); empty: no label filter. */
	labels: string[];
	/** RB-08: any milestone, none, or one milestone id. */
	milestone: MilestoneFilter;
}

export type MilestoneFilter = 'any' | 'none' | { id: string };

/** Label ids a filter keeps at most (a project has at most 30 labels). */
const FILTER_LABELS_MAX = 30;

const pick = <T extends string>(values: string[], allowed: readonly T[]): T[] => {
	const set = new Set(values);
	const kept = allowed.filter((v) => set.has(v));
	// Every value chosen is the same as none chosen: no filter.
	return kept.length === allowed.length ? [] : kept;
};

/** Filters from the URL; unknown values are dropped, never an error. */
export function parseFilters(params: URLSearchParams): TaskFilters {
	const raw = params.get('assignee') ?? '';
	const assignee: AssigneeFilter =
		raw === 'me' || raw === 'none' ? raw : isUuid(raw) ? { userId: raw.toLowerCase() } : 'any';
	const labels = [
		...new Set(
			params
				.getAll('label')
				.filter(isUuid)
				.map((v) => v.toLowerCase())
		)
	].slice(0, FILTER_LABELS_MAX);
	const m = params.get('milestone') ?? '';
	const milestone: MilestoneFilter =
		m === 'none' ? 'none' : isUuid(m) ? { id: m.toLowerCase() } : 'any';
	return {
		statuses: pick(params.getAll('status'), TASK_STATUSES),
		priorities: pick(params.getAll('priority'), TASK_PRIORITIES),
		assignee,
		labels,
		milestone
	};
}

export function parseSort(params: URLSearchParams): { sort: TaskSort; dir: SortDir } {
	const sort = params.get('sort') ?? '';
	const dir = params.get('dir') ?? '';
	return {
		sort: (TASK_SORTS as readonly string[]).includes(sort) ? (sort as TaskSort) : 'number',
		dir: (SORT_DIRS as readonly string[]).includes(dir) ? (dir as SortDir) : 'desc'
	};
}

/** `?page=N`, 1 … LIMITS.pageMax; anything else is page 1. */
export function parsePage(params: URLSearchParams): number {
	const raw = params.get('page') ?? '';
	if (!/^\d{1,5}$/.test(raw)) return 1;
	const n = Number(raw);
	return n >= 1 && n <= LIMITS.pageMax ? n : 1;
}

/** The filters (and sort) as a query string, for links that keep them. */
export function filtersQuery(
	filters: TaskFilters,
	extra: Record<string, string | undefined> = {}
): URLSearchParams {
	const q = new URLSearchParams();
	for (const s of filters.statuses) q.append('status', s);
	for (const p of filters.priorities) q.append('priority', p);
	if (filters.assignee !== 'any')
		q.set(
			'assignee',
			typeof filters.assignee === 'string' ? filters.assignee : filters.assignee.userId
		);
	for (const l of filters.labels) q.append('label', l);
	if (filters.milestone !== 'any')
		q.set('milestone', filters.milestone === 'none' ? 'none' : filters.milestone.id);
	for (const [k, v] of Object.entries(extra)) if (v !== undefined) q.set(k, v);
	return q;
}
