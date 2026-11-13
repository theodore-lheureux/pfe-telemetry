import type {
	OverviewMetric,
	OverviewNode,
	OverviewSectionResult,
} from "../overview.server";

/** The sections whose metrics show a node is up; processes alone do not. */
const PRESENCE = new Set(["cpu", "memory"]);

function presence(
	sources: OverviewSectionResult[],
	period: "current" | "previous",
) {
	const byBucket = new Map<number, Set<string>>();
	const nodes = new Set<string>();
	for (const source of sources)
		for (const [node, buckets] of Object.entries(source.reporting[period])) {
			nodes.add(node);
			for (const bucket of buckets) {
				const reporting = byBucket.get(bucket) ?? new Set();
				reporting.add(node);
				byBucket.set(bucket, reporting);
			}
		}
	return { byBucket, nodes };
}

/** Nodes reporting CPU or memory, from those sections; null when neither applies. */
export function nodesMetric(
	sections: OverviewSectionResult[],
): OverviewMetric | null {
	const sources = sections.filter((section) => PRESENCE.has(section.section));
	if (!sources.length) return null;
	const current = presence(sources, "current");
	const previous = presence(sources, "previous");
	const pointsOf = (reporting: Map<number, Set<string>>) =>
		sources[0].metric.series.map(({ bucketMs }) => ({
			bucketMs,
			value: reporting.get(bucketMs)?.size || null,
		}));
	return {
		stat: "nodes",
		current: current.nodes.size || null,
		previous: previous.nodes.size || null,
		series: pointsOf(current.byBucket),
		previousSeries: pointsOf(previous.byBucket),
	};
}

/** One row per node with the values of every loaded section, busiest CPU first. */
export function mergeNodes(sections: OverviewSectionResult[]) {
	const nodes = new Map<string, OverviewNode>();
	for (const section of sections)
		for (const node of section.nodes) {
			const known = nodes.get(node.id);
			nodes.set(node.id, {
				id: node.id,
				hostname: known?.hostname ?? node.hostname,
				values: { ...known?.values, ...node.values },
			});
		}
	return [...nodes.values()].sort(
		(a, b) => (b.values.cpu ?? -1) - (a.values.cpu ?? -1),
	);
}
