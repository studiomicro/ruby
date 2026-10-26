import { requireViewer } from '#lib/server/hr/access';
import { hasReports, selfApprovalOpen } from '#lib/server/timeoff/repo';
import type { LayoutServerLoad } from './$types';

/**
 * The time-off section's tabs (display only: every page and action checks access itself). Approvals for HR,
 * managers, admins (the fallback approver) and a requester who may self-approve; Team for HR and managers; Settings for HR.
 */
export const load: LayoutServerLoad = async (event) => {
	const { viewer } = await requireViewer(event);
	const [manages, self] = await Promise.all([
		hasReports(event.locals.db, viewer),
		selfApprovalOpen(event.locals.db, viewer)
	]);
	return {
		tabs: {
			approvals: viewer.isHr || viewer.isAdmin || manages || self,
			team: viewer.isHr || manages,
			settings: viewer.isHr
		}
	};
};
