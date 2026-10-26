/**
 * Yearly entitlement of a balance-type leave (owner answer 2026-10-26, "UU default"): the full `annualHalfDays`
 * from the first calendar year after the start year; in the start year 1/12 of it per full month from the start
 * date to December (a start on the 1st counts that month); nothing before the start year or without a start date.
 * Rounded down to whole half-days.
 */
export function annualEntitlement(input: {
	startOn: string | null;
	period: number;
	annualHalfDays: number;
}): number {
	if (!input.startOn) return 0;
	const year = Number(input.startOn.slice(0, 4));
	const month = Number(input.startOn.slice(5, 7));
	const day = Number(input.startOn.slice(8, 10));
	if (input.period < year) return 0;
	if (input.period > year) return input.annualHalfDays;
	const months = 12 - month + (day === 1 ? 1 : 0);
	return Math.max(0, Math.floor((input.annualHalfDays * months) / 12));
}

/** The policy line shown to employees and HR. */
export const STATUTORY_NOTE =
	'Annual leave follows UU Ketenagakerjaan: 12 days a year, 1 day per full month in the first year. Unused days do not carry over; HR can add an adjustment.';
