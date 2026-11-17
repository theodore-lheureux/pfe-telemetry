import { m } from "@recount/i18n/messages";
import type { ChartPoint } from "../charts";
import type { QueryResult, SeriesResult } from "../contracts";

// Charts span the whole requested range on the interval's bucket grid, so a missing
// bucket shows as a gap instead of the axis shrinking to where data happens to exist.

/** Bucket starts (ms) covering [from, to), aligned to the interval like the server's buckets. */
export function bucketGrid(from: Date, to: Date, seconds: number) {
	const step = seconds * 1000;
	const grid: number[] = [];
	for (
		let bucket = Math.floor(from.getTime() / step) * step;
		bucket < to.getTime();
		bucket += step
	)
		grid.push(bucket);
	return grid;
}

/** Points on every grid bucket; buckets without a value are null, which charts draw as gaps. */
export function onGrid(points: ChartPoint[], grid: number[]): ChartPoint[] {
	const byBucket = new Map(points.map((point) => [point.bucketMs, point]));
	return grid.map((bucketMs) => {
		const point = byBucket.get(bucketMs);
		return {
			bucketMs,
			value: point?.value ?? null,
			...(point?.low === undefined ? {} : { low: point.low, high: point.high }),
		};
	});
}

export type Coverage = Record<string, number[]> | null;

/** Whether a node, or any node when none is given, reported during a bucket; null when unknown. */
export function online(
	coverage: Coverage,
	bucketMs: number,
	node?: string | null,
): boolean | null {
	if (!coverage) return null;
	if (node) return node in coverage ? coverage[node].includes(bucketMs) : null;
	return Object.values(coverage).some((buckets) => buckets.includes(bucketMs));
}

/** Contiguous runs of buckets in which no node reported, as [from, to) in ms. */
export function offlineBands(grid: number[], coverage: Coverage, step: number) {
	if (!coverage) return [];
	const reported = new Set(Object.values(coverage).flat());
	const bands: { from: number; to: number }[] = [];
	for (const bucket of grid) {
		if (reported.has(bucket)) continue;
		const last = bands.at(-1);
		if (last && last.to === bucket) last.to = bucket + step;
		else bands.push({ from: bucket, to: bucket + step });
	}
	return bands;
}

/** Why a series has no value in a bucket: its node, or any node when not grouped by node. */
export function gapReason(
	result: QueryResult,
	series: SeriesResult,
	bucketMs: number,
) {
	if (series.comparison) return m.insight_gap_unknown();
	const node =
		result.groupBy[0] === "node" && !series.other ? series.group[0] : undefined;
	const state = online(result.coverage, bucketMs, node);
	if (state === null) return m.insight_gap_unknown();
	return state ? m.insight_gap_online() : m.insight_gap_offline();
}
