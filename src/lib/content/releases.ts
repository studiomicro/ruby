import { parseReleases } from '#lib/shared/releases';

/** Every `releases/<version>.md`, read at build time, newest first. */
export const RELEASES = parseReleases(
	import.meta.glob<string>('./releases/*.md', { query: '?raw', import: 'default', eager: true })
);

/** The newest version, which is the one that is live. */
export const LATEST_VERSION: string | undefined = RELEASES[0]?.version;
