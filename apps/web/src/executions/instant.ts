import { m } from "@recount/i18n/messages";
import type { QueryResult, SeriesResult } from "../analytics/contracts";
import { bucketGrid, gapReason } from "../analytics/insight/grid";
import { unitLabel } from "../analytics/metric-names";

type MeasureResult = QueryResult["measures"][number];

/** One measure's part of a result, charted on its own because each has its own unit. */
export function measureResult(
	result: QueryResult,
	measure: MeasureResult,
): QueryResult {
	return {
		...result,
		measures: [measure],
		series: result.series.filter((series) => series.measure === measure.name),
	};
}

export function resultGrid(result: QueryResult) {
	return bucketGrid(result.from, result.to, result.bucketSeconds ?? 60);
}

/** The last bucket in which any series has a value, else the last bucket. */
export function latestBucket(result: QueryResult, grid = resultGrid(result)) {
	let latest: number | null = null;
	for (const series of result.series)
		for (const point of series.points)
			if (
				point.value !== null &&
				point.bucketMs !== null &&
				(latest === null || point.bucketMs > latest)
			)
				latest = point.bucketMs;
	return latest ?? grid.at(-1) ?? result.from.getTime();
}

/** The bucket holding an instant, kept within the result's buckets. */
export function bucketAt(
	result: QueryResult,
	at: number,
	grid = resultGrid(result),
) {
	const step = (result.bucketSeconds ?? 60) * 1000;
	const first = grid[0] ?? result.from.getTime();
	const last = grid.at(-1) ?? first;
	return Math.min(last, Math.max(first, Math.floor(at / step) * step));
}

/** A measure's unit in words; CPU time per second reads as busy cores. */
export function unitText(measure: Pick<MeasureResult, "unit" | "calculation">) {
	const unit = unitLabel(measure.unit) || measure.unit;
	if (measure.calculation !== "rate") return unit;
	if (measure.unit === "s") return m.execution_timeline_unit_cores();
	return m.execution_timeline_unit_per_second({ unit });
}

export interface InstantValue {
	measure: MeasureResult;
	node: string;
	series: SeriesResult | null;
	value: number | null;
	/** Why there is no value: the node was offline, online without data, or unknown. */
	gap: string | null;
}

function missingReason(
	result: QueryResult,
	measure: MeasureResult,
	node: string,
	series: SeriesResult | null,
	bucketMs: number,
) {
	// Past the series limit a node may have values the result left out.
	if (!series && result.limited) return m.execution_timeline_not_shown();
	return gapReason(
		result,
		series ?? { measure: measure.name, group: [node], points: [] },
		bucketMs,
	);
}

/** Each measure's value on each node in one bucket; missing values say why. */
export function instantValues(
	result: QueryResult,
	nodes: string[],
	bucketMs: number,
): InstantValue[] {
	return result.measures.flatMap((measure) =>
		nodes.map((node) => {
			const series =
				result.series.find(
					(entry) =>
						entry.measure === measure.name &&
						!entry.comparison &&
						entry.group[0] === node,
				) ?? null;
			const value =
				series?.points.find((point) => point.bucketMs === bucketMs)?.value ??
				null;
			return {
				measure,
				node,
				series,
				value,
				gap:
					value === null
						? missingReason(result, measure, node, series, bucketMs)
						: null,
			};
		}),
	);
}
