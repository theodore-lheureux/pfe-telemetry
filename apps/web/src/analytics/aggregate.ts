import type { Combine, SeriesResult } from "./contracts";

const LEVELS: Partial<Record<Combine, number>> = {
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
			return percentile(values, LEVELS[how] ?? 0.5);
	}
}

/**
 * Collapses each measure's or formula's groups into one series per window, bucket by
 * bucket, so a breakdown can show, for example, the 99th percentile across nodes.
 */
export function aggregateGroups(
	series: SeriesResult[],
	how: Combine,
): SeriesResult[] {
	const merged = new Map<
		string,
		{
			measure: string;
			comparison: boolean;
			buckets: Map<number | null, number[]>;
		}
	>();
	for (const entry of series) {
		const comparison = entry.comparison ?? false;
		const key = JSON.stringify([entry.measure, comparison]);
		let target = merged.get(key);
		if (!target) {
			target = { measure: entry.measure, comparison, buckets: new Map() };
			merged.set(key, target);
		}
		for (const point of entry.points) {
			const values = target.buckets.get(point.bucketMs) ?? [];
			if (point.value !== null) values.push(point.value);
			target.buckets.set(point.bucketMs, values);
		}
	}
	return [...merged.values()].map((entry) => ({
		measure: entry.measure,
		group: [],
		...(entry.comparison ? { comparison: true } : {}),
		points: [...entry.buckets]
			.sort(([a], [b]) => (a ?? 0) - (b ?? 0))
			.map(([bucketMs, values]) => ({
				bucketMs,
				value: combineValues(values, how),
			})),
	}));
}
