import type { MetricCoverage } from "./contracts";

export function coverageMeasure(
	name: string,
	metric: string,
	kind: string,
	calculation: "last" | "max" | "avg",
	combine: "sum" | "count" | "max",
) {
	return {
		name,
		metric,
		calculation,
		combine,
		filters: [
			{ field: 'attributes["coverage"]', op: "eq" as const, values: [kind] },
		],
	};
}

export const omissionName = (measure: string) => `${measure}~omitted`;

export function omissionMeasure(
	measure: string,
	coverage: MetricCoverage | undefined,
) {
	if (coverage?.mode !== "excluded") return [];
	return [
		coverageMeasure(
			omissionName(measure),
			coverage.metric,
			coverage.omitted,
			"avg",
			"sum",
		),
	];
}

export function coverageMeasures(coverage: MetricCoverage | undefined) {
	if (coverage?.mode !== "partial") return [];
	const { metric, shown, total, omitted } = coverage;
	return [
		coverageMeasure("omitted", metric, omitted, "max", "max"),
		...(shown ? [coverageMeasure("shown", metric, shown, "last", "sum")] : []),
		...(total
			? [
					coverageMeasure("total", metric, total, "last", "sum"),
					coverageMeasure("nodes", metric, total, "last", "count"),
				]
			: []),
	];
}
