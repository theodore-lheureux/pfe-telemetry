import { expect, test } from "bun:test";
import { MAX_RANGE_SECONDS } from "../../src/analytics/contracts";
import { loadQuery, loadRange } from "../../src/executions/overlap-load.server";
import { LOAD_NODE_LIMIT } from "../../src/executions/overlaps";

const span = (from: string, to: string, nodeId = "node") => ({
	nodeId,
	from: new Date(from),
	to: new Date(to),
});

test("the load range covers whole buckets of the execution's active time", () => {
	expect(
		loadRange([
			span("2026-11-03T10:00:03Z", "2026-11-03T10:04:00Z", "a"),
			span("2026-11-03T10:01:00Z", "2026-11-03T10:09:55Z", "b"),
		]),
	).toEqual({
		from: new Date("2026-11-03T10:00:00Z"),
		to: new Date("2026-11-03T10:10:00Z"),
		interval: "10s",
	});
	// The last observation is included even on a bucket boundary.
	expect(
		loadRange([span("2026-11-03T10:00:00Z", "2026-11-03T10:10:00Z")]).to,
	).toEqual(new Date("2026-11-03T10:10:10Z"));
});

test("long executions show their most recent analytics range within the query limits", () => {
	const spans = [span("2026-01-01T00:00:00Z", "2026-11-03T10:30:00Z")];
	const range = loadRange(spans);
	expect(range.interval).toBe("1d");
	expect(range.to).toEqual(new Date("2026-11-04T00:00:00Z"));
	expect((range.to.getTime() - range.from.getTime()) / 1000).toBe(
		MAX_RANGE_SECONDS,
	);
	const query = loadQuery(
		"run:long",
		Array.from({ length: LOAD_NODE_LIMIT }, (_, index) =>
			span(spans[0].from.toISOString(), spans[0].to.toISOString(), `n${index}`),
		),
		["cpu", "memory"],
	);
	expect(query.measures.map((measure) => measure.name)).toEqual([
		"cpu_execution",
		"cpu_others",
		"cpu_unlabelled",
		"memory_execution",
		"memory_others",
		"memory_unlabelled",
	]);
	expect(query.filters?.[0].values).toHaveLength(LOAD_NODE_LIMIT);
});
