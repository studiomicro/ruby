/**
 * Release notes: parsing, ordering and the "is there something new" comparison. Pure; the files are loaded by
 * `#lib/content/releases` and rendered only through `#lib/ui/kit/Markdown.svelte`.
 */

export interface Release {
	version: string;
	/** `YYYY-MM-DD`. */
	date: string;
	title: string;
	/** Markdown. */
	body: string;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parses `a.b.c` into numbers, or null. */
function parts(version: string): [number, number, number] | null {
	const m = SEMVER.exec(version);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. Both must be `a.b.c`. */
export function compareVersions(a: string, b: string): number {
	const pa = parts(a);
	const pb = parts(b);
	if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
	return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/** One release file (`---` front matter with version, date, title; then Markdown). Throws on a malformed file. */
export function parseRelease(raw: string, name = 'release'): Release {
	const m = FRONT_MATTER.exec(raw);
	if (!m) throw new Error(`${name}: missing front matter`);
	const fields = new Map<string, string>();
	for (const line of (m[1] ?? '').split(/\r?\n/)) {
		const i = line.indexOf(':');
		if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
	}
	const version = fields.get('version') ?? '';
	const date = fields.get('date') ?? '';
	const title = fields.get('title') ?? '';
	if (!SEMVER.test(version)) throw new Error(`${name}: bad version "${version}"`);
	if (!DATE.test(date) || Number.isNaN(Date.parse(date)))
		throw new Error(`${name}: bad date "${date}"`);
	if (!title) throw new Error(`${name}: missing title`);
	return { version, date, title, body: (m[2] ?? '').trim() };
}

/** Parses every file, rejects a duplicate version and a file name that is not `<version>.md`, newest first. */
export function parseReleases(files: Record<string, string>): Release[] {
	const releases = Object.entries(files).map(([path, raw]) => {
		const name = path.split('/').pop() ?? path;
		const release = parseRelease(raw, name);
		if (name !== `${release.version}.md`)
			throw new Error(`${name}: file name must be ${release.version}.md`);
		return release;
	});
	const seen = new Set<string>();
	for (const r of releases) {
		if (seen.has(r.version)) throw new Error(`duplicate release ${r.version}`);
		seen.add(r.version);
	}
	return releases.sort((a, b) => compareVersions(b.version, a.version));
}

/** Whether the newest release is newer than the last one the viewer opened (`null`: never opened any). */
export function hasUnseen(latest: string | undefined, seen: string | null): boolean {
	if (!latest) return false;
	if (seen === null || !SEMVER.test(seen)) return true;
	return compareVersions(latest, seen) > 0;
}

/** The anchor id of one version (`v0-2-0`). */
export const releaseAnchor = (version: string): string => `v${version.replaceAll('.', '-')}`;

/** The `APP_VERSION` var in `wrangler.jsonc` text, or null. */
export function appVersionOf(wranglerText: string): string | null {
	return /"APP_VERSION"\s*:\s*"([^"]*)"/.exec(wranglerText)?.[1] ?? null;
}

/** One problem per disagreement between package.json, `APP_VERSION` and the newest release file. */
export function versionProblems(v: {
	packageVersion: string;
	appVersion: string | null;
	latestRelease: string | undefined;
}): string[] {
	const problems: string[] = [];
	if (v.latestRelease === undefined)
		problems.push('no release notes under src/lib/content/releases');
	if (v.appVersion === null) problems.push('wrangler.jsonc: no APP_VERSION var');
	else if (v.appVersion !== v.packageVersion)
		problems.push(
			`wrangler.jsonc APP_VERSION ${v.appVersion} differs from package.json version ${v.packageVersion}`
		);
	if (v.latestRelease !== undefined && v.latestRelease !== v.packageVersion)
		problems.push(
			`newest release notes ${v.latestRelease} differ from package.json version ${v.packageVersion}`
		);
	return problems;
}
