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

// How long a sample normally takes to reach ingestion: the collector's 1 s export
// cadence plus delivery. Storage lag is covered separately by ingestedThrough.
export const NORMAL_SEND_DELAY_MS = 3000;

export function stillArriving(
	bucket: number,
	step: number,
	ingestedThrough: Date | null,
) {
	return (
		ingestedThrough !== null &&
		bucket + step + NORMAL_SEND_DELAY_MS > ingestedThrough.getTime()
	);
}

export function coverageState(
	coverage: Coverage,
	bucketMs: number,
	step: number,
	ingestedThrough: Date | null,
	node?: string | null,
) {
	if (stillArriving(bucketMs, step, ingestedThrough)) return "arriving";
	const buckets = node
		? coverage?.[node]
		: coverage && Object.values(coverage).flat();
	if (!buckets) return "unknown";
	if (buckets.includes(bucketMs)) return "reported";
	return ingestedThrough ? "missing" : "unknown";
}

export function coverageBands(
	grid: number[],
	coverage: Coverage,
	step: number,
	ingestedThrough: Date | null,
) {
	if (!ingestedThrough) return [];
	const reported = new Set(Object.values(coverage ?? {}).flat());
	const bands: { from: number; to: number; kind: "missing" | "arriving" }[] =
		[];
	for (const bucket of grid) {
		const arriving = stillArriving(bucket, step, ingestedThrough);
		if (!arriving && (!coverage || reported.has(bucket))) continue;
		const kind = arriving ? "arriving" : "missing";
		const last = bands.at(-1);
		if (last && last.kind === kind && last.to === bucket)
			last.to = bucket + step;
		else bands.push({ from: bucket, to: bucket + step, kind });
	}
	return bands;
}
