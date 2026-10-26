import markdownIt, { type MarkdownIt, type StateInline, type Token } from 'markdown-it';

/**
 * The one Markdown renderer (CLAUDE.md › Markdown): task descriptions, pages and comments become HTML only here, on
 * the server and in the browser alike (preview), and `{@html}` is used only on this module's output (through
 * `#lib/ui/kit/Markdown.svelte`). Never call markdown-it anywhere else.
 *
 * Safety: raw HTML is off (`html: false`, so `<script>` and `<img onerror>` are text); every link and image URL
 * passes `isSafeUrl` (http, https, mailto and same-site relative URLs only, checked after markdown-it has decoded
 * entities and escapes); external links get `rel="noopener noreferrer nofollow"`. The page CSP
 * (`script-src 'self'`, `img-src 'self'`) is the second line behind it.
 *
 * Mentions are written `@[Name](user:<uuid>)` and render as `<span class="mention">@Name</span>`; anything else with
 * a `user:` URL is not a link (the scheme is not allowed) and stays text. Given `names` (id → current display name,
 * from the server's `mentionNames`), a mention shows that user's real name, `@unknown user` for an id it lacks, and
 * never the label its author typed. Without `names` (the editor's live preview) the typed label is shown.
 */

/** Longest source rendered; anything after it is cut (a page body is far shorter). */
export const MARKDOWN_MAX_LENGTH = 200_000;
/** Most mention ids one body yields. */
export const MENTIONS_MAX = 50;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** What a mention of an id missing from `names` shows. */
export const UNKNOWN_USER = 'unknown user';

/** The markdown-it env of one render. */
type RenderEnv = { names?: ReadonlyMap<string, string> };

/** `@[Name](user:<uuid>)` at the cursor: a name of 1–80 characters without brackets or line breaks. */
const MENTION = new RegExp(`^@\\[([^\\[\\]\\n\\r]{1,80})\\]\\(user:(${UUID})\\)`);
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
// eslint-disable-next-line no-control-regex -- intentional: control characters in a URL are refused
const UNSAFE_URL_CHAR = /[\u0000- \u007f-\u009f\\]/;

/**
 * Whether `url` (as markdown-it hands it over: entities decoded, then percent-encoded) may be a link or image
 * target: an http, https or mailto URL, or a same-site relative one (`/kb/x`, `#heading`, `./a`, `page`). Refused:
 * every other scheme (`javascript:`, `vbscript:`, `data:`, `file:` …, in any case), anything with a colon before its
 * first `/`, `?` or `#` (so an obfuscated scheme such as `java%09script:` never survives as a "relative" URL),
 * protocol-relative `//host`, backslashes, and whitespace or control characters anywhere.
 */
export function isSafeUrl(url: string): boolean {
	if (url.length === 0 || url.length > 2048 || UNSAFE_URL_CHAR.test(url)) return false;
	if (url.startsWith('//')) return false;
	const head = url.split(/[/?#]/, 1)[0] ?? '';
	const colon = head.indexOf(':');
	if (colon < 0) return true;
	const scheme = head.slice(0, colon + 1).toLowerCase();
	return ALLOWED_SCHEMES.has(scheme) && /^[a-z]+:$/.test(scheme);
}

/** An absolute http(s) URL: it leaves the site, so it gets `rel="noopener noreferrer nofollow"`. */
const isExternal = (href: string) => /^https?:/i.test(href);

function mentionRule(state: StateInline, silent: boolean): boolean {
	if (state.src.charCodeAt(state.pos) !== 0x40 /* @ */) return false;
	const match = MENTION.exec(state.src.slice(state.pos, state.pos + 140));
	if (!match) return false;
	if (!silent) {
		const token = state.push('mention', '', 0);
		token.content = match[1] as string;
		token.meta = { id: (match[2] as string).toLowerCase() };
	}
	state.pos += match[0].length;
	return true;
}

function createRenderer(): MarkdownIt {
	const md = markdownIt({ html: false, linkify: true, typographer: false, breaks: false });
	md.validateLink = isSafeUrl;
	md.inline.ruler.before('link', 'mention', mentionRule);
	md.renderer.rules.mention = (tokens, idx, _options, env) => {
		const token = tokens[idx];
		const names = (env as RenderEnv | undefined)?.names;
		const label = names
			? (names.get((token?.meta as { id: string } | undefined)?.id ?? '') ?? UNKNOWN_USER)
			: (token?.content ?? '');
		return `<span class="mention">@${md.utils.escapeHtml(label)}</span>`;
	};
	const defaultLinkOpen =
		md.renderer.rules.link_open ??
		((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
	md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
		const token = tokens[idx] as Token;
		const href = String(token.attrGet('href') ?? '');
		if (isExternal(href)) token.attrSet('rel', 'noopener noreferrer nofollow');
		return defaultLinkOpen(tokens, idx, options, env, self);
	};
	return md;
}

const md = createRenderer();

/**
 * Markdown source → safe HTML (see the module comment). Empty input gives ''. `names` maps lower-cased user ids to
 * the names their mentions show.
 */
export function renderMarkdown(source: string, names?: ReadonlyMap<string, string>): string {
	if (!source) return '';
	const env: RenderEnv = { names };
	return md.render(source.slice(0, MARKDOWN_MAX_LENGTH), env);
}

/**
 * The user ids a body mentions, lower-cased, de-duplicated, in order of appearance, at most MENTIONS_MAX. Read from
 * the parsed document, so `@[Name](user:…)` inside a code span or code block is not a mention. Whether an id is a
 * live, active user is the caller's check.
 */
export function extractMentionIds(source: string): string[] {
	if (!source) return [];
	const ids: string[] = [];
	const visit = (tokens: Token[]) => {
		for (const token of tokens) {
			if (ids.length >= MENTIONS_MAX) return;
			if (token.type === 'mention') {
				const id = (token.meta as { id: string }).id;
				if (!ids.includes(id)) ids.push(id);
			}
			if (token.children) visit(token.children);
		}
	};
	visit(md.parse(source.slice(0, MARKDOWN_MAX_LENGTH), {}));
	return ids;
}

/** The mention token for `user` as the editor inserts it: brackets and line breaks in the name are dropped. */
export function mentionMarkup(user: { id: string; name: string }): string {
	const name = user.name.replace(/[[\]\r\n]/g, '').slice(0, 80) || 'user';
	return `@[${name}](user:${user.id})`;
}
