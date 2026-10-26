/** A task's human identifier, `OPS-12`: the canonical way every feature shows a task reference. Pure, no DB. */
export const formatTaskRef = (key: string, number: number): string => `${key}-${number}`;

/** The canonical task URL other features link to. */
export const taskPath = (key: string, number: number): string =>
	`/projects/${encodeURIComponent(key)}/tasks/${number}`;
