/**
 * The org chart as a tree of active employees by `manager_id` (PRD › Org chart). Roots are employees with no
 * manager or whose manager is not in the set (terminated, deleted or missing). Built in memory from one capped
 * query; every node is visited at most once, so stored data can never make it loop, and depth is cut at
 * ORG_DEPTH_MAX.
 */

export const ORG_DEPTH_MAX = 10;

export interface OrgInput {
	id: string;
	fullName: string;
	preferredName: string | null;
	jobTitle: string | null;
	managerId: string | null;
}

export interface OrgNode {
	id: string;
	name: string;
	title: string | null;
	/** Direct reports, including any cut off below ORG_DEPTH_MAX. */
	reportCount: number;
	children: OrgNode[];
	/** Reports exist below the depth cut. */
	truncated: boolean;
}

export function buildOrgTree(rows: readonly OrgInput[]): OrgNode[] {
	const byId = new Map(rows.map((r) => [r.id, r]));
	const children = new Map<string, OrgInput[]>();
	const roots: OrgInput[] = [];
	for (const r of rows) {
		if (r.managerId && r.managerId !== r.id && byId.has(r.managerId)) {
			const list = children.get(r.managerId) ?? [];
			list.push(r);
			children.set(r.managerId, list);
		} else roots.push(r);
	}
	const visited = new Set<string>();
	const build = (r: OrgInput, depth: number): OrgNode => {
		visited.add(r.id);
		const kids = (children.get(r.id) ?? []).filter((k) => !visited.has(k.id));
		const cut = depth >= ORG_DEPTH_MAX;
		return {
			id: r.id,
			name: r.preferredName ? `${r.fullName} (${r.preferredName})` : r.fullName,
			title: r.jobTitle,
			reportCount: kids.length,
			truncated: cut && kids.length > 0,
			children: cut ? [] : kids.map((k) => build(k, depth + 1))
		};
	};
	const tree = roots.map((r) => build(r, 1));
	// Employees only reachable through a cycle (impossible through the app's guarded writes) still show, as roots.
	for (const r of rows) if (!visited.has(r.id)) tree.push(build(r, 1));
	return tree;
}
