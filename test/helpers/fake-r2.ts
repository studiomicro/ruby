/**
 * RB-04: the local R2 bucket from `openLocalD1()` (`env.FILES`, never remote) wrapped with a call log and failure
 * injection. `fail.put` (a put or a multipart start) / `fail.delete` make the next calls throw (each is a count of calls to fail); `onDelete`
 * runs before a delete reaches the bucket, so a test can check what D1 held at that moment.
 */
export function spyR2(real: R2Bucket) {
	const calls: string[] = [];
	const fail = { put: 0, delete: 0 };
	const hooks: { onDelete?: (key: string) => Promise<void> | void } = {};
	const bucket = {
		put: async (...args: Parameters<R2Bucket['put']>) => {
			calls.push(`put ${args[0]}`);
			if (fail.put > 0) {
				fail.put -= 1;
				throw new Error('injected put failure');
			}
			return real.put(...args);
		},
		get: (key: string) => {
			calls.push(`get ${key}`);
			return real.get(key);
		},
		createMultipartUpload: async (...args: Parameters<R2Bucket['createMultipartUpload']>) => {
			calls.push(`multipart ${args[0]}`);
			if (fail.put > 0) {
				fail.put -= 1;
				throw new Error('injected put failure');
			}
			const upload = await real.createMultipartUpload(...args);
			return {
				uploadPart: (n: number, value: Parameters<R2MultipartUpload['uploadPart']>[1]) => {
					calls.push(`part ${n}`);
					return upload.uploadPart(n, value);
				},
				complete: (parts: R2UploadedPart[]) => {
					calls.push('complete');
					return upload.complete(parts);
				},
				abort: () => {
					calls.push('abort');
					return upload.abort();
				}
			};
		},
		head: (key: string) => {
			calls.push(`head ${key}`);
			return real.head(key);
		},
		delete: async (key: string) => {
			calls.push(`delete ${key}`);
			await hooks.onDelete?.(key);
			if (fail.delete > 0) {
				fail.delete -= 1;
				throw new Error('injected delete failure');
			}
			return real.delete(key);
		}
	} as unknown as R2Bucket;
	return {
		bucket,
		calls,
		fail,
		hooks,
		reset() {
			calls.length = 0;
			fail.put = 0;
			fail.delete = 0;
			hooks.onDelete = undefined;
		}
	};
}
