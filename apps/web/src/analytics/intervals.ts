import { INTERVALS, type Interval, MAX_BUCKETS } from "./contracts";

/** The finest interval that keeps a range to roughly 150 buckets and under the limit. */
export function autoInterval(from: Date, to: Date): Interval {
	const seconds = (to.getTime() - from.getTime()) / 1000;
	const intervals = Object.entries(INTERVALS) as [Interval, number][];
	return (
		intervals.find(([, step]) => seconds / step <= 150)?.[0] ??
		intervals.at(-1)?.[0] ??
		"1d"
	);
}

/** The interval a query uses: the chosen one when it fits the range, otherwise automatic. */
export function effectiveInterval(
	chosen: Interval | "auto",
	from: Date,
	to: Date,
): Interval {
	return chosen !== "auto" && intervalFits(chosen, from, to)
		? chosen
		: autoInterval(from, to);
}

/** Whether an interval keeps a range under the bucket limit. */
export function intervalFits(interval: Interval, from: Date, to: Date) {
	return (
		(to.getTime() - from.getTime()) / 1000 / INTERVALS[interval] <= MAX_BUCKETS
	);
}
