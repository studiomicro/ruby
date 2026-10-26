import { requireUser } from '#lib/server/guards';
import { uploadResponse } from '#lib/server/attachments/respond';
import { uploadAttachment } from '#lib/server/attachments/service';
import type { RequestHandler } from './$types';

/** RB-04 upload: one file per request to a live task or page (multipart; JSON or a 303 back with a flash code). */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	return uploadResponse(event.request, await uploadAttachment(event, user));
};
