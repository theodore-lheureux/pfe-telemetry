import type { AnalyticsQuery, SeriesResult } from "./contracts";
import { evaluateFormula, parseFormula } from "./formula";

/** Formulas join inputs by group, bucket and window, never by row order. */
export function formulaSeries(
	query: Pick<AnalyticsQuery, "measures" | "formulas">,
	series: SeriesResult[],
): SeriesResult[] {
	if (!query.formulas?.length) return [];
	const identities = new Map<
		string,
		{
			group: (string | null)[];
			other: boolean;
			comparison: boolean;
			execution?: string;
			buckets: Map<number | null, Map<string, number | null>>;
		}
	>();
	for (const entry of series) {
		const other = entry.other ?? false,
			comparison = entry.comparison ?? false;
		const key = JSON.stringify([
			entry.group,
			other,
			comparison,
			entry.execution ?? null,
		]);
		let identity = identities.get(key);
		if (!identity) {
			identity = {
				group: entry.group,
				other,
				comparison,
				execution: entry.execution,
				buckets: new Map(),
			};
			identities.set(key, identity);
		}
		for (const point of entry.points) {
			const values = identity.buckets.get(point.bucketMs) ?? new Map();
			values.set(entry.measure, point.value);
			identity.buckets.set(point.bucketMs, values);
		}
	}
	return (query.formulas ?? []).flatMap((formula) => {
		const node = parseFormula(
			formula.expression,
			query.measures.map((measure) => measure.name),
		);
		return [...identities.values()].map((identity) => ({
			measure: formula.name,
			group: identity.group,
			...(identity.other ? { other: true } : {}),
			...(identity.comparison ? { comparison: true } : {}),
			...(identity.execution ? { execution: identity.execution } : {}),
			points: [...identity.buckets]
				.sort(([left], [right]) => (left ?? 0) - (right ?? 0))
				.map(([bucketMs, values]) => ({
					bucketMs,
					value: evaluateFormula(node, (name) => values.get(name) ?? null),
				})),
		}));
	});
}
