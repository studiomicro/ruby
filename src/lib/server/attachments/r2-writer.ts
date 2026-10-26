import { HEAD_BYTES } from './content-type';

/**
 * Writes a stream of chunks to one R2 key while holding at most one part in memory. A file that ends within the
 * first part is one `put` of those bytes (a known length). A longer one becomes an R2 multipart upload of
 * PART_BYTES parts (R2's minimum part size; every part but the last has the same size), each sent before more of
 * the body is read. R2 needs the object's metadata when the upload starts, so `metadata` is asked for then, with
 * the file's first bytes (the type check reads them).
 */

/** 5 MiB: R2's minimum multipart part size, and so the memory one upload holds. 25 MB is exactly five parts. */
export const PART_BYTES = 5 * 1024 * 1024;
const FIRST_BUFFER_BYTES = 64 * 1024;

export class StorageError extends Error {
	constructor(cause: unknown) {
		super('storage', { cause });
	}
}

export class R2Writer {
	private buf = new Uint8Array(0);
	private used = 0;
	private head = new Uint8Array(0);
	private upload: R2MultipartUpload | null = null;
	private readonly parts: R2UploadedPart[] = [];
	private written = false;
	size = 0;
	/** The largest buffer held, for the memory bound test. */
	peakBuffered = 0;

	constructor(
		private readonly bucket: R2Bucket,
		private readonly key: string,
		private readonly metadata: (head: Uint8Array) => R2PutOptions
	) {}

	/** Room for `need` more bytes, growing by doubling up to PART_BYTES. */
	private reserve(need: number) {
		if (this.used + need <= this.buf.length) return;
		let next = Math.max(this.buf.length, FIRST_BUFFER_BYTES);
		while (next < this.used + need && next < PART_BYTES) next *= 2;
		const grown = new Uint8Array(Math.min(next, PART_BYTES));
		grown.set(this.buf.subarray(0, this.used));
		this.buf = grown;
		this.peakBuffered = Math.max(this.peakBuffered, grown.length);
	}

	private async flushPart(): Promise<void> {
		try {
			if (!this.upload) {
				const options = this.metadata(this.head);
				this.upload = await this.bucket.createMultipartUpload(this.key, options);
			}
			// Sent and awaited before the buffer is refilled, so it can be reused.
			this.parts.push(await this.upload.uploadPart(this.parts.length + 1, this.buf));
		} catch (e) {
			throw new StorageError(e);
		}
		this.used = 0;
	}

	/** Takes a copy of `chunk` (a view the caller may reuse). */
	async write(chunk: Uint8Array): Promise<void> {
		if (this.head.length < HEAD_BYTES) {
			const add = chunk.subarray(0, HEAD_BYTES - this.head.length);
			const head = new Uint8Array(this.head.length + add.length);
			head.set(this.head);
			head.set(add, this.head.length);
			this.head = head;
		}
		this.size += chunk.length;
		let offset = 0;
		while (offset < chunk.length) {
			const take = Math.min(chunk.length - offset, PART_BYTES - this.used);
			this.reserve(take);
			this.buf.set(chunk.subarray(offset, offset + take), this.used);
			this.used += take;
			offset += take;
			if (this.used === PART_BYTES) await this.flushPart();
		}
	}

	/** Stores what was written; afterwards the object exists under the key. */
	async finish(): Promise<void> {
		try {
			if (!this.upload) {
				await this.bucket.put(this.key, this.buf.subarray(0, this.used), this.metadata(this.head));
			} else {
				if (this.used > 0)
					this.parts.push(
						await this.upload.uploadPart(this.parts.length + 1, this.buf.subarray(0, this.used))
					);
				await this.upload.complete(this.parts);
			}
		} catch (e) {
			throw new StorageError(e);
		}
		this.written = true;
		this.buf = new Uint8Array(0);
	}

	/**
	 * Leaves nothing behind: aborts an unfinished multipart upload, or deletes the object once stored. False when that
	 * failed (a stored object may now be an orphan). Never throws.
	 */
	async discard(): Promise<boolean> {
		this.buf = new Uint8Array(0);
		try {
			if (this.written) await this.bucket.delete(this.key);
			else if (this.upload) await this.upload.abort();
			return true;
		} catch {
			return false;
		}
	}
}
