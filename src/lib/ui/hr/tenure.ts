/** Whole years and months from `start` to `today` (both `YYYY-MM-DD`), e.g. "2 years 3 months"; null if not started. */
export function tenure(start: string | null, today: string): string | null {
	if (!start || start > today) return null;
	const [sy, sm, sd] = start.split('-').map(Number) as [number, number, number];
	const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
	let months = (ty - sy) * 12 + (tm - sm) - (td < sd ? 1 : 0);
	if (months < 0) months = 0;
	const y = Math.floor(months / 12);
	const m = months % 12;
	const parts = [
		...(y ? [`${y} ${y === 1 ? 'year' : 'years'}`] : []),
		...(m || !y ? [`${m} ${m === 1 ? 'month' : 'months'}`] : [])
	];
	return parts.join(' ');
}
