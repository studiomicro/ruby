import { requireUser } from '#lib/server/guards';
import { buildDownloadResponse } from '#lib/server/attachments/service';
import type { RequestHandler } from './$types';

/** RB-04 download: always an attachment, except `?inline=1` for PNG, JPEG, GIF and WebP. */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	return buildDownloadResponse(event, event.params.id, {
		inline: event.url.searchParams.get('inline') === '1'
	});
};
