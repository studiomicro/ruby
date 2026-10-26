import { readdirSync, readFileSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';

/** Runs one migration file statement by statement, as `openLocalD1` does for every file. */
export async function applyMigration(db: D1Database, file: string): Promise<void> {
	const statements = readFileSync(`migrations/${file}`, 'utf8')
		.split('--> statement-breakpoint')
		.map((s) => s.trim())
		.filter(Boolean);
	for (const statement of statements) await db.prepare(statement).run();
}

/**
 * Fresh, non-persisted local D1 (workerd) with every migration applied, plus the proxy's other local bindings
 * (`env.FILES` is a local R2 bucket). Never remote. Call `dispose()`. `before`: only the migrations whose file
 * name sorts before it (a migration test then fills the older schema and applies the rest itself).
 */
export async function openLocalD1(options: { before?: string } = {}): Promise<{
	db: D1Database;
	env: { DB: D1Database; FILES: R2Bucket };
	dispose: () => Promise<void>;
}> {
	const proxy = await getPlatformProxy<{ DB: D1Database; FILES: R2Bucket }>({
		configPath: 'wrangler.jsonc',
		persist: false,
		remoteBindings: false
	});
	try {
		const db = proxy.env.DB;
		const before = options.before;
		for (const file of readdirSync('migrations')
			.filter((f) => f.endsWith('.sql') && (before === undefined || f < before))
			.sort())
			await applyMigration(db, file);
		return { db, env: proxy.env, dispose: () => proxy.dispose() };
	} catch (e) {
		await proxy.dispose();
		throw e;
	}
}

/** Fresh, non-persisted local D1 (workerd) with every migration applied. Never remote. */
export async function withLocalD1(fn: (db: D1Database) => Promise<void>): Promise<void> {
	const { db, dispose } = await openLocalD1();
	try {
		await fn(db);
	} finally {
		await dispose();
	}
}
