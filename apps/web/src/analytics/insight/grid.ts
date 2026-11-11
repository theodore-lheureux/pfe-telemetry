import type { ChartPoint } from "../charts";

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
	const values = new Map(points.map((point) => [point.bucketMs, point.value]));
	return grid.map((bucketMs) => ({
		bucketMs,
		value: values.get(bucketMs) ?? null,
	}));
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
