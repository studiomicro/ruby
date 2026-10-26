/** Every stored enum in one place: the schema's CHECK constraints and the UI read the same lists. */

export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Board columns, in display order. */
export const TASK_STATUSES = [
	'backlog',
	'todo',
	'in_progress',
	'in_review',
	'done',
	'canceled'
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
	backlog: 'Backlog',
	todo: 'To do',
	in_progress: 'In progress',
	in_review: 'In review',
	done: 'Done',
	canceled: 'Canceled'
};

/** Statuses that count as finished: `completed_at` is set on entering one, cleared on leaving. */
export const CLOSED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'canceled']);

export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
	none: 'No priority',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	urgent: 'Urgent'
};

/**
 * RB-12: what kind of work a task is (owner decision O2: a fixed list). Every task has one; `task` is the default
 * and the quiet one (board cards show no badge for it). The UI always shows an icon plus the text, never colour.
 */
export const TASK_TYPES = ['task', 'bug', 'feature_request', 'improvement'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
	task: 'Task',
	bug: 'Bug',
	feature_request: 'Feature request',
	improvement: 'Improvement'
};

/** What a comment or attachment hangs on. */
export const TARGET_KINDS = ['task', 'page'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const NOTIFICATION_KINDS = ['mention', 'assigned', 'comment', 'reminder'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** What a notification points at: a comment or assignment target, or (RB-09 reminders) an event or a personal note. */
export const NOTIFICATION_TARGET_KINDS = [...TARGET_KINDS, 'event', 'personal'] as const;
export type NotificationTargetKind = (typeof NOTIFICATION_TARGET_KINDS)[number];

// ── Calendar and reminders (RB-09; docs/features/rb-09-calendar-reminders/PRD.md) ─────────────────────────────

/** `team`: every active user sees the event; `private`: only its creator and attendees (owner answer O2). */
export const EVENT_VISIBILITIES = ['team', 'private'] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];

export const REC_FREQS = ['daily', 'weekly', 'monthly'] as const;
export type RecFreq = (typeof REC_FREQS)[number];

export const REMINDER_TARGET_KINDS = ['task', 'event', 'personal'] as const;
export type ReminderTargetKind = (typeof REMINDER_TARGET_KINDS)[number];

export const REMINDER_MODES = ['relative', 'absolute'] as const;
export type ReminderMode = (typeof REMINDER_MODES)[number];

/** How a reminder closed; an open one has no outcome. */
export const REMINDER_OUTCOMES = ['sent', 'missed', 'canceled', 'dead'] as const;
export type ReminderOutcome = (typeof REMINDER_OUTCOMES)[number];

// ── HR (RB-05; docs/features/rb-05-hrm-roadmap.md section 4) ─────────────────────────────────────────────

export const EMPLOYMENT_TYPES = [
	'permanent',
	'contract',
	'probation',
	'intern',
	'part_time'
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
	permanent: 'Permanent',
	contract: 'Contract',
	probation: 'Probation',
	intern: 'Intern',
	part_time: 'Part-time'
};

export const EMPLOYEE_STATUSES = ['active', 'terminated'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/**
 * Every `hr_audit_log.action`. The column has no CHECK on purpose (RB-06/RB-07 add actions without a table
 * rebuild); hr/audit.ts refuses any other value.
 */
export const HR_AUDIT_ACTIONS = [
	'employee_create',
	'employee_update',
	'employee_terminate',
	'employee_reinstate',
	'employee_delete',
	'employee_restore',
	'sensitive_view',
	'sensitive_update',
	'emergency_update',
	'compensation_view',
	'compensation_add',
	'user_link',
	'user_unlink',
	'hr_grant',
	'hr_revoke',
	'export',
	'list_terminated',
	// RB-06 time off
	'leave_adjust',
	'leave_type_update',
	'holiday_update',
	'work_days_update',
	'leave_override',
	'leave_self_approve',
	'leave_self_reject',
	// RB-09 (red team L1): an admin purged a deactivated user's calendar events (a count, never a title).
	'calendar_events_purge'
] as const;
export type HrAuditAction = (typeof HR_AUDIT_ACTIONS)[number];

export const HR_AUDIT_ACTION_LABELS: Record<HrAuditAction, string> = {
	employee_create: 'Employee created',
	employee_update: 'Employee changed',
	employee_terminate: 'Employee terminated',
	employee_reinstate: 'Employee reinstated',
	employee_delete: 'Employee deleted',
	employee_restore: 'Employee restored',
	sensitive_view: 'Sensitive field revealed',
	sensitive_update: 'Sensitive fields changed',
	emergency_update: 'Emergency contacts changed',
	compensation_view: 'Salary revealed',
	compensation_add: 'Salary record added',
	user_link: 'Account linked',
	user_unlink: 'Account unlinked',
	hr_grant: 'HR access granted',
	hr_revoke: 'HR access revoked',
	export: 'Directory exported',
	list_terminated: 'Former staff listed',
	leave_adjust: 'Leave balance adjusted',
	leave_type_update: 'Leave type changed',
	holiday_update: 'Holidays changed',
	work_days_update: 'Work days changed',
	leave_override: 'Leave decided or canceled by HR',
	leave_self_approve: 'Leave self-approved (no other approver)',
	leave_self_reject: 'Leave self-rejected (no other approver)',
	calendar_events_purge: 'Calendar events of a deactivated user purged'
};

/**
 * Tier 2 fields of `employee_private`, each stored only as AES-GCM ciphertext (`<field>_enc`). Revealed one at a
 * time by an audited action, never in a page load.
 */
export const SENSITIVE_FIELDS = [
	'birth_date',
	'home_address',
	'personal_phone',
	'personal_email',
	'nik',
	'npwp',
	'bpjs_kes',
	'bpjs_tk',
	'bank_account',
	'bank_holder'
] as const;
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

/** Sensitive fields whose last four digits are kept in a plain `<field>_last4` column for the masked view. */
export const LAST4_FIELDS = ['nik', 'npwp', 'bpjs_kes', 'bpjs_tk', 'bank_account'] as const;

export const SENSITIVE_FIELD_LABELS: Record<SensitiveField, string> = {
	birth_date: 'Birth date',
	home_address: 'Home address',
	personal_phone: 'Personal phone',
	personal_email: 'Personal e-mail',
	nik: 'NIK',
	npwp: 'NPWP',
	bpjs_kes: 'BPJS Kesehatan',
	bpjs_tk: 'BPJS Ketenagakerjaan',
	bank_account: 'Bank account number',
	bank_holder: 'Account holder'
};

/** Encrypted fields of an emergency contact and of a salary record (tier 2 and tier 3), revealed like the above. */
export const CONTACT_SECRET_FIELDS = ['contact_name', 'contact_phone'] as const;
export const COMPENSATION_SECRET_FIELDS = ['compensation_amount', 'compensation_note'] as const;
export type RevealField =
	| SensitiveField
	| (typeof CONTACT_SECRET_FIELDS)[number]
	| (typeof COMPENSATION_SECRET_FIELDS)[number];

/** The only currency a salary record holds; stored as minor units (sen) next to the ISO code. */
export const COMPENSATION_CURRENCIES = ['IDR'] as const;
// ── RB-08 project management plus ───────────────────────────────────────────────────────────────────────────

/** The eight label colours; the UI maps each to a light and a dark shade (a chip always carries its name too). */
export const LABEL_COLORS = [
	'gray',
	'red',
	'orange',
	'yellow',
	'green',
	'blue',
	'purple',
	'pink'
] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export const MILESTONE_STATUSES = ['open', 'closed'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** What a saved view opens: a project's list or board, or (RB-12) the cross-project Issues page. */
export const VIEW_KINDS = ['list', 'board', 'issues'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

// ── Time off (RB-06; docs/features/rb-06-time-off/PRD.md) ──────────────────────────────────────────────────

/** `balance`: counted against a yearly entitlement in the ledger; `logged`: recorded, no balance. */
export const LEAVE_KINDS = ['balance', 'logged'] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'canceled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
	pending: 'Pending',
	approved: 'Approved',
	rejected: 'Rejected',
	canceled: 'Canceled'
};

/** Signed half-day entries of the append-only `leave_ledger`. */
export const LEAVE_LEDGER_KINDS = ['grant', 'usage', 'reversal', 'adjustment'] as const;
export type LeaveLedgerKind = (typeof LEAVE_LEDGER_KINDS)[number];

/** A single-date request may cover the morning or the afternoon only. */
export const HALF_DAY_PARTS = ['none', 'am', 'pm'] as const;
export type HalfDayPart = (typeof HALF_DAY_PARTS)[number];

export const HALF_DAY_LABELS: Record<HalfDayPart, string> = {
	none: 'Full day',
	am: 'Morning only',
	pm: 'Afternoon only'
};
