import { TASK_TYPES, TASK_TYPE_LABELS } from '#lib/shared/enums';

/** Select options for the task types (RB-12), in their fixed order. */
export const TYPE_OPTIONS = TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABELS[t] }));
