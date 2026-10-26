import type { SessionUser } from '../auth/session';

/** Delete: the uploader or an admin (owner decision 2026-10-26). */
export const canDeleteAttachment = (
	actor: Pick<SessionUser, 'id' | 'role'>,
	row: { uploadedBy: string }
): boolean => actor.role === 'admin' || row.uploadedBy === actor.id;
