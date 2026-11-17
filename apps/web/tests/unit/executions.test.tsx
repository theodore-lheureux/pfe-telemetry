import { expect, test } from "bun:test";
import type { QueryResult } from "../../src/analytics/contracts";
import type { ExecutionFact } from "../../src/executions/contracts";
import {
	applySelection,
	parseExecutionSearch,
} from "../../src/executions/execution-search";
import {
	bucketAt,
	instantValues,
	latestBucket,
	unitText,
} from "../../src/executions/instant";
import { EXECUTION_MEASURES } from "../../src/executions/measurements";
import { executionMeasurementQuery } from "../../src/executions/measurements.server";
import {
	axisTicks,
	executionSpan,
	isLive,
	place,
	timelineNodes,
} from "../../src/executions/timeline";
import {
	parseExecutionKey,
	parseExecutionReference,
} from "../../src/executions/validation";
import { decodeCalendarTimestamp } from "../../src/lib/calendar";

const reference = {
	organizationId: "org",
	projectId: "019a4790-d1da-7000-8000-000000000002",
	executionKey: "slurm:48213",
};
test("calendar decoding rejects malformed timestamps and execution references discard selectors", () => {
	expect(decodeCalendarTimestamp("2026-11-03T12:00:00+02:00").time).toBe(
		Date.UTC(2026, 10, 3, 10),
	);
	for (const value of [
		"2026-02-30T00:00:00Z",
		"2026-11-03",
		"2026-11-03T24:00:00Z",
		"2026-11-03T00:00:00.000001Z",
	])
		expect(decodeCalendarTimestamp(value).error).toBeTruthy();
	expect(
		parseExecutionReference({
			...reference,
			sourceId: "foreign",
			hostId: "other-resource",
		}),
	).toEqual(reference);
});

test("execution keys keep their case and reject malformed claims", () => {
	expect(parseExecutionKey("run:Node-A/one")).toBe("run:Node-A/one");
	for (const value of [
		"",
		"a".repeat(129),
		"bad\nkey",
		"run:key\n",
		"é",
		" run:key",
	])
		expect(() => parseExecutionKey(value)).toThrow();
});

const start = Date.UTC(2026, 10, 3, 10);
function fact(
	overrides: Partial<ExecutionFact> & {
		from: number;
		last: number;
		end?: number;
	},
): ExecutionFact {
	const { from, last, end, ...rest } = overrides;
	return {
		nodeId: "node-a",
		participantId: "participant-a",
		factId: crypto.randomUUID(),
		kind: 2,
		processResourceId: "resource",
		namespaceId: "pidns:1",
		pid: 42,
		startTimeTicks: "100",
		ownerUid: 1000,
		environmentVariable: "RECOUNT_EXECUTION",
		firstSeen: new Date(start + from),
		lastSeen: new Date(start + last),
		ended: end === undefined ? null : new Date(start + end),
		...rest,
	};
}

test("the span ends at explicit ends or last observations, never at the current time", () => {
	const lifecycle = fact({
		kind: 1,
		factId: "participant-a",
		from: 0,
		last: 50_000,
		end: 60_000,
	});
	const open = fact({ from: 10_000, last: 90_000 });
	expect(executionSpan([lifecycle, open])).toEqual({
		from: start,
		to: start + 90_000,
	});
	expect(isLive([lifecycle, open])).toBe(true);
	expect(isLive([lifecycle])).toBe(false);
	// A later explicit end wins over an earlier last observation.
	expect(
		executionSpan([open, fact({ from: 5_000, last: 80_000, end: 120_000 })]),
	).toEqual({ from: start + 5_000, to: start + 120_000 });
	// A single observation still spans one second.
	const instant = fact({ from: 0, last: 0 });
	expect(executionSpan([instant])).toEqual({ from: start, to: start + 1000 });
	expect(executionSpan([])).toBeNull();
});

test("bars clamp to the span and stay visible without overflowing it", () => {
	const span = { from: 0, to: 1000 };
	expect(place(span, 250, 750)).toEqual({ left: 25, width: 50 });
	expect(place(span, -500, 500)).toEqual({ left: 0, width: 50 });
	expect(place(span, 500, 5000)).toEqual({ left: 50, width: 50 });
	// Zero-length and reversed intervals become a sliver that still fits the track.
	expect(place(span, 400, 400)).toEqual({ left: 40, width: 0.75 });
	expect(place(span, 400, 100)).toEqual({ left: 40, width: 0.75 });
	expect(place(span, 1000, 1000)).toEqual({ left: 99.25, width: 0.75 });
	expect(place(span, 2000, 3000)).toEqual({ left: 99.25, width: 0.75 });
});

test("rows group processes under their participant and order nodes and processes by start", () => {
	const facts = [
		fact({
			nodeId: "node-b",
			participantId: "late",
			from: 30_000,
			last: 40_000,
		}),
		fact({
			nodeId: "node-b",
			participantId: "late",
			factId: "late",
			kind: 1,
			from: 20_000,
			last: 40_000,
			end: 45_000,
		}),
		fact({ pid: 9, factId: "second", from: 10_000, last: 20_000 }),
		fact({ pid: 7, factId: "tie", from: 10_000, last: 20_000, end: 25_000 }),
		fact({ pid: 3, factId: "first", from: 5_000, last: 20_000 }),
		fact({
			kind: 1,
			factId: "participant-a",
			from: 0,
			last: 30_000,
		}),
		// A membership whose lifecycle is missing keeps its own participant row.
		fact({
			participantId: "orphan",
			factId: "orphan",
			from: 1_000,
			last: 2_000,
		}),
	];
	const span = executionSpan(facts);
	if (!span) throw new Error("Expected a span");
	const nodes = timelineNodes(facts, span);
	expect(nodes.map((node) => node.nodeId)).toEqual(["node-a", "node-b"]);
	const [first, orphan] = nodes[0].participants;
	expect(first.participantId).toBe("participant-a");
	expect(first.lifecycle?.open).toBe(true);
	expect(first.processes.map((entry) => entry.fact.factId)).toEqual([
		"first",
		"tie",
		"second",
	]);
	expect(first.processes.map((entry) => entry.open)).toEqual([
		true,
		false,
		true,
	]);
	expect(orphan).toMatchObject({ participantId: "orphan", lifecycle: null });
	const late = nodes[1].participants[0];
	expect(late.lifecycle?.open).toBe(false);
	expect(late.lifecycle?.placement.left).toBeCloseTo(44.44, 1);
	expect(late.lifecycle?.placement.left).toBeLessThan(
		late.processes[0].placement.left,
	);
});

test("axis ticks stay inside the span at a readable step", () => {
	const span = { from: start + 7_000, to: start + 3_600_000 };
	const ticks = axisTicks(span);
	expect(ticks.length).toBeGreaterThan(1);
	expect(ticks.length).toBeLessThanOrEqual(6);
	expect(ticks[0]).toBeGreaterThanOrEqual(span.from);
	expect(ticks.at(-1)).toBeLessThanOrEqual(span.to);
	expect(ticks[1] - ticks[0]).toBe(600_000);
	// Spans longer than the largest step still get at most `count` ticks.
	expect(
		axisTicks({ from: 0, to: 400 * 86_400_000 }).length,
	).toBeLessThanOrEqual(6);
});

function result(overrides: Partial<QueryResult> = {}): QueryResult {
	return {
		shape: "timeseries",
		from: new Date(start),
		to: new Date(start + 5 * 60_000),
		bucketSeconds: 60,
		groupBy: ["node"],
		measures: [
			{
				name: "memory",
				metric: "recount.process.memory.rss",
				unit: "By",
				calculation: "last",
			},
		],
		formulas: [],
		series: [
			{
				measure: "memory",
				group: ["node-a"],
				points: [
					{ bucketMs: start, value: 2 },
					{ bucketMs: start + 120_000, value: 0 },
					{ bucketMs: start + 180_000, value: null },
				],
			},
		],
		limited: false,
		compared: null,
		coverage: {
			"node-a": [start, start + 60_000, start + 120_000],
			"node-b": [start + 60_000],
		},
		...overrides,
	};
}

test("the instant snaps to a bucket and missing values say why rather than reading as zero", () => {
	const data = result();
	expect(latestBucket(data)).toBe(start + 120_000);
	expect(latestBucket(result({ series: [] }))).toBe(start + 240_000);
	expect(bucketAt(data, start + 90_000)).toBe(start + 60_000);
	expect(bucketAt(data, start - 1)).toBe(start);
	expect(bucketAt(data, start + 86_400_000)).toBe(start + 240_000);
	const at = (bucket: number) =>
		instantValues(data, ["node-a", "node-b"], bucket).map((entry) => [
			entry.node,
			entry.value,
			entry.gap,
		]);
	expect(at(start + 120_000)).toEqual([
		["node-a", 0, null],
		["node-b", null, "Node offline"],
	]);
	expect(at(start + 60_000)).toEqual([
		["node-a", null, "No data (node online)"],
		["node-b", null, "No data (node online)"],
	]);
	expect(
		instantValues(result({ coverage: null }), ["node-a"], start + 180_000),
	).toMatchObject([{ value: null, gap: "No data" }]);
	// Past the series limit, a node without a series was left out, not silent.
	expect(
		instantValues(result({ limited: true }), ["node-a", "node-c"], start).map(
			(entry) => [entry.node, entry.value, entry.gap],
		),
	).toEqual([
		["node-a", 2, null],
		["node-c", null, "Not shown: select this machine"],
	]);
});

test("units stay explicit, with CPU time per second read as cores", () => {
	expect(unitText({ unit: "By", calculation: "last" })).toBe("bytes");
	expect(unitText({ unit: "By", calculation: "rate" })).toBe(
		"bytes per second",
	);
	expect(unitText({ unit: "s", calculation: "rate" })).toBe(
		"cores (CPU seconds per second)",
	);
});

test("execution measurements cover the observed span, filtered to the execution and node", () => {
	const span = { from: start, to: start + 90_000 };
	const query = executionMeasurementQuery(
		"run:shared",
		span,
		[...EXECUTION_MEASURES],
		"node-a",
	);
	expect(query).toMatchObject({
		shape: "timeseries",
		range: {
			from: new Date(start).toISOString(),
			// Whole 2-second buckets, past the last observation.
			to: new Date(start + 92_000).toISOString(),
		},
		interval: "2s",
		groupBy: ["node"],
		other: false,
		filters: [
			{ field: "execution", op: "eq", values: ["run:shared"] },
			{ field: "node", op: "eq", values: ["node-a"] },
		],
	});
	const long = executionMeasurementQuery(
		"run:shared",
		{ from: 0, to: 40 * 86_400_000 },
		[...EXECUTION_MEASURES],
	);
	if (!("from" in long.range)) throw new Error("Expected an absolute range");
	expect(Date.parse(long.range.to) - Date.parse(long.range.from)).toBe(
		30 * 86_400_000,
	);
	expect(long.filters).toHaveLength(1);
});

test("selection search drops unreadable values and patches clear or keep them", () => {
	expect(
		parseExecutionSearch({ node: "node-a", at: "2026-11-03T10:00:00+01:00" }),
	).toEqual({ node: "node-a", at: "2026-11-03T09:00:00.000Z" });
	expect(parseExecutionSearch({ node: "bad node", at: "soon" })).toEqual({});
	const current = { node: "node-a", at: "2026-11-03T09:00:00.000Z" };
	expect(applySelection(current, { at: start })).toEqual({
		node: "node-a",
		at: new Date(start).toISOString(),
	});
	expect(applySelection(current, { node: null })).toEqual({
		at: current.at,
	});
	expect(applySelection(current, { node: "node-b", at: null })).toEqual({
		node: "node-b",
	});
});
