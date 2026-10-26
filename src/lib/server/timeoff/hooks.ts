import type { Db } from '../db';

/**
 * RB-05 terminate and soft-delete hook: the batch item that cancels the employee's pending requests, effective only
 * when the employee UPDATE before it wrote `updatedAt` (so a refused termination or deletion cancels nothing).
 */
export function cancelPendingRequests(
	db: Db,
	actorId: string,
	employeeId: string,
	employeeUpdatedAt: number,
	now: number,
	why: 'terminated' | 'deleted'
): D1PreparedStatement {
	const state = why === 'terminated' ? `status = 'terminated'` : 'deleted_at IS NOT NULL';
	return db.$client
		.prepare(
			`UPDATE leave_requests SET status = 'canceled', decision_note = ?5, decided_by = ?2,
				decided_at = ?3, updated_at = ?3
			 WHERE employee_id = ?1 AND status = 'pending'
				AND EXISTS (SELECT 1 FROM employees WHERE id = ?1 AND ${state} AND updated_at = ?4)`
		)
		.bind(
			employeeId,
			actorId,
			now,
			employeeUpdatedAt,
			why === 'terminated' ? 'Employee left' : 'Employee record deleted'
		);
}
