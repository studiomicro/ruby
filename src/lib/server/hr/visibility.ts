/**
 * Who sees what of an employee (docs/features/rb-05-hrm-roadmap.md section 4.2), as pure functions over the
 * viewer and the employee row. Tier 0: any active user, live active employees only. Tier 1: self, the direct manager
 * (never skip-level), HR. Tier 2: self and HR. Tier 3 (salary): HR only. Admin is not HR by itself.
 */

export interface Viewer {
	userId: string;
	isHr: boolean;
	isAdmin: boolean;
	/** The live, active employee record linked to the viewer's account, if any. */
	ownEmployeeId: string | null;
}

export interface EmployeeScope {
	id: string;
	userId: string | null;
	managerId: string | null;
	status: 'active' | 'terminated';
	deletedAt: number | null;
}

export interface Access {
	/** The profile exists for this viewer at all (else 404, the same answer as a missing id). */
	visible: boolean;
	self: boolean;
	manager: boolean;
	hr: boolean;
	tier1: boolean;
	tier2: boolean;
	tier3: boolean;
}

export function viewerAccess(viewer: Viewer, employee: EmployeeScope): Access {
	const hr = viewer.isHr;
	const live = employee.deletedAt === null;
	const visible = hr || (live && employee.status === 'active');
	const self = visible && live && employee.userId !== null && employee.userId === viewer.userId;
	const manager =
		visible &&
		live &&
		viewer.ownEmployeeId !== null &&
		employee.managerId === viewer.ownEmployeeId &&
		employee.id !== viewer.ownEmployeeId;
	return {
		visible,
		self,
		manager,
		hr,
		tier1: visible && (self || manager || hr),
		tier2: visible && (self || hr),
		tier3: visible && hr
	};
}

/** The masked form of an identifier: `•••• 1234` from its stored last four digits, else "Hidden". */
export function maskLast4(last4: string | null | undefined): string {
	return last4 && /^\d{1,4}$/.test(last4) ? `•••• ${last4}` : 'Hidden';
}
