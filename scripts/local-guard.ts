export const LOCAL_STATE_DIR = '.wrangler/state';

const FORBIDDEN = /^(--remote|--preview|--env|-e)(=.*)?$/;

/** Seed and reset only ever touch the local D1. Any flag that could point elsewhere stops the script. */
export function assertLocalOnly(argv: readonly string[]): void {
	const bad = argv.find((a) => FORBIDDEN.test(a));
	if (bad)
		throw new Error(
			`Refusing: "${bad}" is not allowed; this script only touches the local database.`
		);
}

/**
 * The local state directory: RUBY_PERSIST_TO (the e2e run uses its own) or LOCAL_STATE_DIR. Always inside
 * `.wrangler/`, so a reset can never delete anything else.
 */
export function localStateDir(env: Record<string, string | undefined> = process.env): string {
	const dir = env.RUBY_PERSIST_TO || LOCAL_STATE_DIR;
	if (!/^\.wrangler\/[A-Za-z0-9._-]+$/.test(dir))
		throw new Error(
			`Refusing: RUBY_PERSIST_TO must be a folder directly under .wrangler/, not "${dir}".`
		);
	return dir;
}
