/**
 * The served type of an attachment comes only from this table, keyed by the cleaned name's extension; the type a
 * client sent is ignored. Everything else (HTML, SVG, JavaScript, XML, executables …) is
 * `application/octet-stream`.
 */
const TYPES: Record<string, string> = {
	pdf: 'application/pdf',
	txt: 'text/plain',
	md: 'text/markdown',
	csv: 'text/csv',
	json: 'application/json',
	zip: 'application/zip',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text',
	ods: 'application/vnd.oasis.opendocument.spreadsheet',
	odp: 'application/vnd.oasis.opendocument.presentation',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	mp4: 'video/mp4',
	mp3: 'audio/mpeg'
};

export const OCTET_STREAM = 'application/octet-stream';

/** Every type a download may carry; a stored value outside it is served as octet-stream. */
export const SERVED_TYPES: ReadonlySet<string> = new Set([...Object.values(TYPES), OCTET_STREAM]);

/** The image types a download may show inline (never SVG, never HTML). */
export const INLINE_TYPES: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp'
]);

/** How many leading bytes `classify` needs. */
export const HEAD_BYTES = 16;

const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0) =>
	head.length >= at + bytes.length && bytes.every((b, i) => head[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Whether the first bytes are really an image of `type` (a `.png` must start like a PNG to be shown). */
function magicMatches(type: string, head: Uint8Array): boolean {
	switch (type) {
		case 'image/png':
			return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		case 'image/jpeg':
			return startsWith(head, [0xff, 0xd8, 0xff]);
		case 'image/gif':
			return startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'));
		case 'image/webp':
			return startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8);
		default:
			return false;
	}
}

/**
 * The stored type of a file named `filename` (already cleaned) whose first bytes are `head`, and whether it may be
 * shown inline. An image whose bytes do not match its extension is stored as octet-stream.
 */
export function classify(
	filename: string,
	head: Uint8Array
): { contentType: string; inlineSafe: boolean } {
	const dot = filename.lastIndexOf('.');
	const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
	const type = Object.hasOwn(TYPES, ext) ? (TYPES[ext] as string) : OCTET_STREAM;
	if (!INLINE_TYPES.has(type)) return { contentType: type, inlineSafe: false };
	return magicMatches(type, head)
		? { contentType: type, inlineSafe: true }
		: { contentType: OCTET_STREAM, inlineSafe: false };
}
