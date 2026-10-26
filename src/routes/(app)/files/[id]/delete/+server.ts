import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { deleteResponse } from '#lib/server/attachments/respond';
import { deleteAttachment } from '#lib/server/attachments/service';
import type { RequestHandler } from './$types';

/** RB-04 delete by the uploader or an admin (form post with `confirm=yes`; JSON or a 303 back with a flash code). */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const form = await readFormBody(event.request);
	const returnTo = textField(form, 'returnTo') || null;
	if (textField(form, 'confirm') !== 'yes')
		return deleteResponse(
			event.request,
			{ ok: false, code: 'bad_request', targetPath: null },
			returnTo
		);
	return deleteResponse(
		event.request,
		await deleteAttachment(event, user, event.params.id),
		returnTo
	);
};
