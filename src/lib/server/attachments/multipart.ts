import { ATTACHMENT_LIMITS } from '#lib/shared/attachments';

/**
 * A streaming `multipart/form-data` reader (RFC 7578) for uploads, so a 25 MB file is never held in memory: part
 * bodies are handed on chunk by chunk as they arrive, and only a delimiter-sized tail is kept back. Every byte read
 * counts against the body bound; the declared Content-Length is checked before the first read; reads stop at a
 * wall-clock deadline. Header blocks, text fields and the number of parts are capped.
 */

/** The most an upload body may carry: the file plus the multipart framing and the small fields. */
export const UPLOAD_BODY_MAX_BYTES =
	ATTACHMENT_LIMITS.maxBytes + ATTACHMENT_LIMITS.bodyOverheadBytes;
/** A 25 MB upload from a phone on a slow uplink takes minutes; a body still trickling after this is cut off. */
export const UPLOAD_BODY_TIMEOUT_MS = 10 * 60 * 1000;
/** Longest header block of one part (Content-Disposition with a long file name, Content-Type). */
const HEADER_MAX_BYTES = 8 * 1024;
/** More parts than an honest upload form sends (four fields) is refused. */
const MAX_PARTS = 16;
/** RFC 2046 boundary: 1–70 of these characters, not ending in a space. */
const BOUNDARY_RE = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;

export type MultipartFailure = 'too_large' | 'bad_request' | 'unsupported';

export class MultipartError extends Error {
	constructor(readonly reason: 'too_large' | 'bad_request') {
		super(`multipart ${reason}`);
	}
}

export interface PartHeader {
	/** The form field name. */
	name: string;
	/** The file name the client sent ('' for an empty file input), or null for a text field. */
	filename: string | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Index of `needle` in `hay` at or after `from`, or -1. */
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
	const first = needle[0];
	const last = hay.length - needle.length;
	for (
		let i = hay.indexOf(first ?? 0, from);
		i !== -1 && i <= last;
		i = hay.indexOf(first ?? 0, i + 1)
	) {
		let j = 1;
		while (j < needle.length && hay[i + j] === needle[j]) j += 1;
		if (j === needle.length) return i;
	}
	return -1;
}

/** The `boundary` parameter of a multipart/form-data Content-Type, or why there is none. */
export function multipartBoundary(contentType: string | null): string | MultipartFailure {
	const type = contentType ?? '';
	if ((type.split(';', 1)[0] ?? '').trim().toLowerCase() !== 'multipart/form-data')
		return 'unsupported';
	const m = /;\s*boundary=(?:"([^"]*)"|([^;\s]*))/i.exec(type);
	const boundary = m?.[1] ?? m?.[2] ?? '';
	return BOUNDARY_RE.test(boundary) ? boundary : 'bad_request';
}

/** HTML's form encoding escapes `"`, CR and LF in names as %22, %0D and %0A; nothing else is decoded. */
const unescapeName = (s: string) =>
	s.replace(/%(22|0D|0A)/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** `name` and `filename` of a part's `Content-Disposition: form-data; …` header, or null when it is not one. */
export function parseDispositionHeader(value: string): PartHeader | null {
	const params = new Map<string, string>();
	let rest = value.trim();
	const type = /^form-data\s*(;|$)/i.exec(rest);
	if (!type) return null;
	rest = rest.slice(type[0].length);
	while (rest.length) {
		const m = /^\s*([A-Za-z0-9!#$&+\-.^_`|~*]+)\s*=\s*(?:"([^"]*)"|([^;"]*))\s*(;|$)/.exec(rest);
		if (!m) return null;
		const key = (m[1] ?? '').toLowerCase();
		if (!params.has(key)) params.set(key, m[2] ?? (m[3] ?? '').trim());
		rest = rest.slice(m[0].length);
	}
	const name = params.get('name');
	if (name === undefined) return null;
	let filename = params.has('filename') ? unescapeName(params.get('filename') ?? '') : null;
	const star = /^utf-8''(.*)$/i.exec(params.get('filename*') ?? '');
	if (star) {
		try {
			filename = decodeURIComponent(star[1] ?? '');
		} catch {
			return null;
		}
	}
	return { name: unescapeName(name), filename };
}

type State = 'preamble' | 'delimiter' | 'body' | 'done';

export class MultipartReader {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private readonly delimiter: Uint8Array;
	private readonly deadline: number;
	/** Bytes read and not yet handed on. A virtual CRLF lets the first delimiter match like every other one. */
	private buf: Uint8Array = encoder.encode('\r\n');
	private state: State = 'preamble';
	private total = 0;
	private parts = 0;
	/** The most bytes held at once, for the memory bound test. */
	peakBuffered = 0;

	constructor(
		body: ReadableStream<Uint8Array>,
		boundary: string,
		private readonly max: number = UPLOAD_BODY_MAX_BYTES,
		timeoutMs: number = UPLOAD_BODY_TIMEOUT_MS
	) {
		this.reader = body.getReader();
		this.delimiter = encoder.encode(`\r\n--${boundary}`);
		this.deadline = Date.now() + timeoutMs;
	}

	/** The reader for `request`'s body, or why it cannot be read (Content-Length checked before any read). */
	static open(
		request: Request,
		max: number = UPLOAD_BODY_MAX_BYTES,
		timeoutMs: number = UPLOAD_BODY_TIMEOUT_MS
	): MultipartReader | MultipartFailure {
		const boundary = multipartBoundary(request.headers.get('content-type'));
		if (boundary === 'unsupported' || boundary === 'bad_request') return boundary;
		const declared = request.headers.get('content-length');
		if (declared !== null && Number(declared) > max) return 'too_large';
		if (!request.body) return 'bad_request';
		return new MultipartReader(request.body, boundary, max, timeoutMs);
	}

	/** Reads one more chunk into the buffer; false at the end of the body. */
	private async fill(): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new MultipartError('bad_request')),
				Math.max(0, this.deadline - Date.now())
			);
		});
		try {
			const { done, value } = await Promise.race([this.reader.read(), late]);
			if (done) return false;
			this.total += value.byteLength;
			if (this.total > this.max) throw new MultipartError('too_large');
			const joined = new Uint8Array(this.buf.length + value.byteLength);
			joined.set(this.buf);
			joined.set(value, this.buf.length);
			this.buf = joined;
			this.peakBuffered = Math.max(this.peakBuffered, joined.length);
			return true;
		} catch (e) {
			throw e instanceof MultipartError ? e : new MultipartError('bad_request');
		} finally {
			clearTimeout(timer);
		}
	}

	private async need(bytes: number): Promise<void> {
		while (this.buf.length < bytes)
			if (!(await this.fill())) throw new MultipartError('bad_request');
	}

	/**
	 * Hands the current part's body to `sink` chunk by chunk (views into the buffer; copy what you keep) and returns
	 * its length. Only the delimiter-sized tail that could start the next delimiter is held back.
	 */
	async pipe(sink: (chunk: Uint8Array) => Promise<void> | void): Promise<number> {
		if (this.state !== 'body' && this.state !== 'preamble') throw new Error('no part body to read');
		let size = 0;
		for (;;) {
			const at = indexOfBytes(this.buf, this.delimiter);
			if (at !== -1) {
				if (at > 0) await sink(this.buf.subarray(0, at));
				size += at;
				this.buf = this.buf.subarray(at + this.delimiter.length);
				this.state = 'delimiter';
				return size;
			}
			const safe = this.buf.length - (this.delimiter.length - 1);
			if (safe > 0) {
				await sink(this.buf.subarray(0, safe));
				size += safe;
				this.buf = this.buf.subarray(safe);
			}
			if (!(await this.fill())) throw new MultipartError('bad_request');
		}
	}

	/**
	 * The current part's body as UTF-8 text, or null when it is longer than `max` bytes (the rest is read and
	 * dropped, never kept).
	 */
	async text(max: number): Promise<string | null> {
		const chunks: Uint8Array[] = [];
		let size = 0;
		await this.pipe((chunk) => {
			size += chunk.length;
			if (size <= max) chunks.push(chunk.slice());
		});
		if (size > max) return null;
		const all = new Uint8Array(size);
		let at = 0;
		for (const c of chunks) {
			all.set(c, at);
			at += c.length;
		}
		return decoder.decode(all);
	}

	/** The next part's header, or null after the closing delimiter. An unread part body is skipped first. */
	async next(): Promise<PartHeader | null> {
		if (this.state === 'done') return null;
		if (this.state === 'preamble' || this.state === 'body') await this.pipe(() => {});
		// After a delimiter: optional transport padding, then `--` (the end) or CRLF (a part follows).
		for (;;) {
			await this.need(1);
			if (this.buf[0] !== 0x20 && this.buf[0] !== 0x09) break;
			this.buf = this.buf.subarray(1);
		}
		await this.need(2);
		if (this.buf[0] === 0x2d && this.buf[1] === 0x2d) {
			this.state = 'done';
			return null;
		}
		if (this.buf[0] !== 0x0d || this.buf[1] !== 0x0a) throw new MultipartError('bad_request');
		this.buf = this.buf.subarray(2);
		if ((this.parts += 1) > MAX_PARTS) throw new MultipartError('bad_request');

		const end = encoder.encode('\r\n\r\n');
		let at = indexOfBytes(this.buf, end);
		while (at === -1) {
			if (this.buf.length > HEADER_MAX_BYTES || !(await this.fill()))
				throw new MultipartError('bad_request');
			at = indexOfBytes(this.buf, end);
		}
		if (at > HEADER_MAX_BYTES) throw new MultipartError('bad_request');
		const lines = decoder.decode(this.buf.subarray(0, at)).split('\r\n');
		this.buf = this.buf.subarray(at + end.length);
		const dispositions = lines.filter((l) => /^content-disposition\s*:/i.test(l));
		if (dispositions.length !== 1) throw new MultipartError('bad_request');
		const header = parseDispositionHeader((dispositions[0] ?? '').replace(/^[^:]*:/, ''));
		if (!header) throw new MultipartError('bad_request');
		this.state = 'body';
		return header;
	}

	/** Stops reading the body (an early refusal); never throws. */
	cancel(): void {
		this.reader.cancel().catch(() => {});
	}
}
