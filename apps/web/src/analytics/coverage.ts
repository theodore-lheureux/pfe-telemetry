import type { MetricPresentation } from "./contracts";

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

export const omissionName = (measure: string) => `${measure}_omitted`;

export function omissionMeasure(
	measure: string,
	coverage: MetricPresentation["coverage"],
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
