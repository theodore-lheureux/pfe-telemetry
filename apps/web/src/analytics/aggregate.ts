import type { Combine, SeriesResult, Spread } from "./contracts";

export const PERCENTILE_LEVELS: Partial<Record<Combine, number>> = {
	p50: 0.5,
	p90: 0.9,
	p95: 0.95,
	p99: 0.99,
};

/**
 * The value at a percentile level, as an exact nearest rank: the same value ClickHouse's
 * `quantileExact` picks, so percentiles agree wherever they are computed.
 */
export function percentile(values: number[], level: number) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(level * sorted.length))];
}

/** Values combined into one; null when there are none to combine. */
export function combineValues(values: number[], how: Combine) {
	if (!values.length) return null;
	switch (how) {
		case "sum":
			return values.reduce((total, value) => total + value, 0);
		case "avg":
			return values.reduce((total, value) => total + value, 0) / values.length;
		case "count":
			return values.length;
		case "min":
			return Math.min(...values);
		case "max":
			return Math.max(...values);
		default:
			return percentile(values, PERCENTILE_LEVELS[how] ?? 0.5);
	}
}

/** A bucket's band across the groups it collapses: all of them, or the middle half. */
function bandOf(values: number[], spread: Spread) {
	if (!values.length) return { low: null, high: null };
	if (spread === "range")
		return { low: Math.min(...values), high: Math.max(...values) };
	return { low: percentile(values, 0.25), high: percentile(values, 0.75) };
}

/**
 * Collapses each measure's or formula's groups into one series per window or execution, bucket by
 * bucket, so a breakdown can show, for example, the 99th percentile across nodes. With a
 * spread, each bucket's band covers the groups' values, so formulas computed per group
 * get one too.
 */
export function aggregateGroups(
	series: SeriesResult[],
	how: Combine,
	spread?: Spread,
): SeriesResult[] {
	const merged = new Map<
		string,
		{
			measure: string;
			comparison: boolean;
			execution?: string;
			buckets: Map<number | null, number[]>;
		}
	>();
	for (const entry of series) {
		const comparison = entry.comparison ?? false;
		const key = JSON.stringify([
			entry.measure,
			comparison,
			entry.execution ?? null,
		]);
		let target = merged.get(key);
		if (!target) {
			target = {
				measure: entry.measure,
				comparison,
				execution: entry.execution,
				buckets: new Map(),
			};
			merged.set(key, target);
		}
		for (const point of entry.points) {
			const values = target.buckets.get(point.bucketMs) ?? [];
			if (point.value !== null) values.push(point.value);
			target.buckets.set(point.bucketMs, values);
		}
	}
	const level = PERCENTILE_LEVELS[how];
	return [...merged.values()].map((entry) => ({
		measure: entry.measure,
		group: [],
		...(entry.comparison ? { comparison: true } : {}),
		...(entry.execution ? { execution: entry.execution } : {}),
		...(level === undefined
			? {}
			: {
					percentile: {
						level,
						values: Math.max(
							0,
							...[...entry.buckets.values()].map((values) => values.length),
						),
					},
				}),
		points: [...entry.buckets]
			.sort(([a], [b]) => (a ?? 0) - (b ?? 0))
			.map(([bucketMs, values]) => ({
				bucketMs,
				value: combineValues(values, how),
				...(spread ? bandOf(values, spread) : {}),
			})),
	}));
}
