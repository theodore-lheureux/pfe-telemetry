import { expect, test } from "bun:test";
import { aggregateGroups } from "../../src/analytics/aggregate";
import { compileMeasure } from "../../src/analytics/compile.server";
import type {
	AnalyticsQuery,
	MetricDefinition,
	QueryResult,
} from "../../src/analytics/contracts";
import { formulaSeries } from "../../src/analytics/formula-series";
import { parseQuery } from "../../src/analytics/validation";
import {
	executionPeriod,
	overlapMs,
	ownerUids,
	parameterRows,
	sharedNodes,
} from "../../src/executions/compare/context";
import {
	formatDuration,
	formatElapsed,
} from "../../src/executions/compare/elapsed";
import {
	comparedMeasurement,
	comparisonInterval,
	comparisonQuery,
	plannedMeasurements,
} from "../../src/executions/compare/measurements";
import type { ExecutionFact } from "../../src/executions/contracts";
import { InputError } from "../../src/lib/input-error";

const measure = {
	name: "cpu",
	metric: "process.cpu.time",
	calculation: "rate",
	combine: "sum",
} as const;
const aligned = {
	shape: "timeseries",
	range: { executions: ["run:a", "slurm:13"] },
	interval: "10s",
	measures: [measure],
};

function reason(run: () => unknown) {
	try {
		run();
	} catch (error) {
		if (error instanceof InputError) return error.reason;
		throw error;
	}
	throw new Error("Expected the query to be rejected");
}

test("execution ranges list distinct valid keys and exclude calendar comparisons", () => {
	expect(parseQuery(aligned).range).toEqual({
		executions: ["run:a", "slurm:13"],
	});
	expect(
		parseQuery({ ...aligned, shape: "table", interval: undefined }).range,
	).toEqual({ executions: ["run:a", "slurm:13"] });
	for (const range of [
		{ executions: [] },
		{ executions: ["run:a", "run:a"] },
		{ executions: ["run:a", "run:b", "run:c", "run:d", "run:e"] },
		{ executions: [" run:a"] },
		{ executions: [42] },
	])
		expect(reason(() => parseQuery({ ...aligned, range }))).toBe(
			"INVALID_QUERY",
		);
	expect(
		reason(() => parseQuery({ ...aligned, compare: { previous: true } })),
	).toBe("INVALID_QUERY");
});

test("aligned windows count buckets from their origin inside the project predicate", () => {
	const query = parseQuery(aligned);
	const scope = { kind: 2, behavior: "counter" } as const;
	const from = new Date("2026-11-16T10:00:03.250Z");
	const to = new Date("2026-11-16T10:05:00.001Z");
	const compiled = compileMeasure(
		{
			...query,
			filters: [{ field: "execution", op: "eq", values: ["run:a"] }],
		},
		query.measures[0],
		scope,
		{ projectId: "project", from, to, origin: from },
	);
	expect(compiled.sql).toContain(
		"intDiv(time_unix_nano - {origin:UInt64}, {step:UInt64}) * {step:UInt64} AS bucket",
	);
	// Elapsed counter rates divide by the time their differences span.
	expect(compiled.sql).toContain(
		"sum(greatest(d, 0)) / nullIf((max(t) - min(previous)) / 1e9, 0)",
	);
	expect(compiled.sql).toContain(
		"FROM execution_participants FINAL WHERE project_id = {project:String}",
	);
	expect(compiled.sql.match(/project_id = \{project:String\}/g)).toHaveLength(
		3,
	);
	expect(compiled.params).toMatchObject({
		project: "project",
		origin: "1794823203250000000",
		from: "1794823203250000000",
		to: "1794823500001000000",
		step: "10000000000",
	});
	expect(Object.values(compiled.params)).toContainEqual(["run:a"]);

	// Delta rates divide by the time the period covers within each elapsed bucket.
	expect(
		compileMeasure(
			query,
			query.measures[0],
			{ kind: 2, behavior: "delta" },
			{ projectId: "project", from, to, origin: from },
		).sql,
	).toContain(
		"sum(v) / ((least(bucket + {step:UInt64}, {to:UInt64} - {origin:UInt64}) - bucket) / 1e9)",
	);

	const absolute = compileMeasure(
		parseQuery({ ...aligned, range: { last: "1h" } }),
		query.measures[0],
		scope,
		{ projectId: "project", from, to },
	);
	expect(absolute.sql).toContain(
		"intDiv(time_unix_nano, {step:UInt64}) * {step:UInt64} AS bucket",
	);
	// Calendar rates keep dividing by the time the range covers within each bucket.
	expect(absolute.sql).toContain(
		"sum(greatest(d, 0)) / ((least(bucket + {step:UInt64}, {to:UInt64}) - greatest(bucket, {from:UInt64})) / 1e9)",
	);
	expect(absolute.sql).not.toContain("previous");
	expect(absolute.sql).not.toContain("origin");
	expect(absolute.params).not.toHaveProperty("origin");
});

test("formulas and group aggregations never combine different executions", () => {
	const point = (bucketMs: number, value: number) => ({ bucketMs, value });
	const series = [
		{ measure: "A", group: ["n"], execution: "run:a", points: [point(0, 4)] },
		{ measure: "B", group: ["n"], execution: "run:a", points: [point(0, 2)] },
		{ measure: "A", group: ["n"], execution: "run:b", points: [point(0, 9)] },
		{ measure: "B", group: ["n"], execution: "run:b", points: [point(0, 3)] },
	];
	expect(
		formulaSeries(
			{
				measures: [
					{ ...measure, name: "A" },
					{ ...measure, name: "B" },
				],
				formulas: [{ name: "F", expression: "A / B" }],
			},
			series,
		),
	).toEqual([
		{ measure: "F", group: ["n"], execution: "run:a", points: [point(0, 2)] },
		{ measure: "F", group: ["n"], execution: "run:b", points: [point(0, 3)] },
	]);
	expect(
		aggregateGroups(
			[
				...series,
				{
					measure: "A",
					group: ["m"],
					execution: "run:a",
					points: [point(0, 6)],
				},
			].filter((entry) => entry.measure === "A"),
			"sum",
		),
	).toEqual([
		{ measure: "A", group: [], execution: "run:a", points: [point(0, 10)] },
		{ measure: "A", group: [], execution: "run:b", points: [point(0, 9)] },
	]);
});

const at = (seconds: number) =>
	new Date(Date.UTC(2026, 10, 16, 10, 0, seconds));
function fact(overrides: Partial<ExecutionFact>): ExecutionFact {
	return {
		nodeId: "node-1",
		participantId: "p",
		factId: "f",
		kind: 1,
		processResourceId: null,
		namespaceId: null,
		pid: null,
		startTimeTicks: null,
		ownerUid: 1000,
		environmentVariable: "RECOUNT_EXECUTION",
		firstSeen: at(0),
		lastSeen: at(30),
		ended: null,
		...overrides,
	};
}

test("context follows the runner's period rule and marks differences", () => {
	const a = {
		facts: [
			fact({ firstSeen: at(10), lastSeen: at(40), ended: at(50) }),
			fact({ kind: 2, nodeId: "node-2", firstSeen: at(5), lastSeen: at(45) }),
		],
		firstSeen: at(5),
		lastSeen: at(45),
	};
	expect(executionPeriod(a)).toEqual({ from: at(5), to: at(50) });
	const b = {
		facts: [
			fact({
				nodeId: "node-2",
				ownerUid: 0,
				firstSeen: at(60),
				lastSeen: at(90),
			}),
		],
		firstSeen: at(60),
		lastSeen: at(90),
	};
	expect(executionPeriod(b)).toEqual({ from: at(60), to: at(90) });
	expect(overlapMs(executionPeriod(a), executionPeriod(b))).toBe(0);
	expect(overlapMs({ from: at(0), to: at(70) }, executionPeriod(b))).toBe(
		10_000,
	);
	expect(sharedNodes(a, b)).toEqual(["node-2"]);
	expect(ownerUids(a)).toEqual([1000]);
	expect(
		parameterRows({ dataset: "small", seed: "1" }, { seed: "1", threads: "8" }),
	).toEqual([
		{ key: "dataset", values: ["small", null], differs: true },
		{ key: "seed", values: ["1", "1"], differs: false },
		{ key: "threads", values: [null, "8"], differs: true },
	]);
});

function metric(name: string, behavior: MetricDefinition["behavior"]) {
	return { name, behavior, unit: "s" } as MetricDefinition;
}

test("measurements plan per metric behavior and classify what can be compared", () => {
	const planned = plannedMeasurements([
		metric("process.cpu.time", "counter"),
		metric("recount.process.memory.rss", "gauge"),
	]);
	expect(planned.map((entry) => [entry.name, entry.calculation])).toEqual([
		["cpu", "rate"],
		["memory", "last"],
		["io", null],
	]);
	expect(planned[2].definition).toBeNull();
	expect(comparisonQuery(planned, ["run:a", "run:b"], "10s")).toEqual({
		shape: "timeseries",
		range: { executions: ["run:a", "run:b"] },
		interval: "10s",
		measures: [
			{
				name: "cpu",
				metric: "process.cpu.time",
				calculation: "rate",
				combine: "sum",
			},
			{
				name: "memory",
				metric: "recount.process.memory.rss",
				calculation: "last",
				combine: "sum",
			},
		],
	} satisfies AnalyticsQuery);
	expect(comparisonQuery(plannedMeasurements([]), ["run:a"], "10s")).toBeNull();
	expect(comparisonInterval([60_000, 3_600_000])).toBe("1m");
	// Short executions keep buckets at least one typical collection cycle long.
	expect(comparisonInterval([30_000])).toBe("10s");
	expect(comparisonInterval([30 * 86_400_000])).toBe("1d");

	const result = {
		bucketSeconds: 10,
		series: [
			{
				measure: "cpu",
				group: [],
				execution: "run:a",
				points: [
					{ bucketMs: 0, value: 1 },
					{ bucketMs: 20_000, value: 3 },
				],
			},
			{
				measure: "cpu",
				group: [],
				execution: "run:b",
				points: [
					{ bucketMs: 0, value: null },
					{ bucketMs: 10_000, value: 2 },
				],
			},
			{
				measure: "memory",
				group: [],
				execution: "run:b",
				points: [{ bucketMs: 0, value: 5 }],
			},
		],
	} as unknown as QueryResult;
	const executions = [
		{ key: "run:a", durationMs: 30_000 },
		{ key: "run:b", durationMs: 15_000 },
	];
	const cpu = comparedMeasurement(result, "cpu", executions);
	expect(cpu.status).toBe("comparable");
	// Missing buckets stay null on each execution's own grid, which ends with its period.
	expect(cpu.series.map((entry) => entry.points)).toEqual([
		[
			{ bucketMs: 0, value: 1 },
			{ bucketMs: 10_000, value: null },
			{ bucketMs: 20_000, value: 3 },
			{ bucketMs: 30_000, value: null },
		],
		[
			{ bucketMs: 0, value: null },
			{ bucketMs: 10_000, value: 2 },
		],
	]);
	// Once the result lists the server's periods, they decide each grid.
	expect(
		comparedMeasurement(
			{
				...result,
				executions: [
					{ execution: "run:b", from: new Date(5000), to: new Date(30_000) },
				],
			},
			"cpu",
			executions,
		).series[1].points.map((point) => point.bucketMs),
	).toEqual([0, 10_000, 20_000]);
	const memory = comparedMeasurement(result, "memory", executions);
	expect(memory.status).toBe("incomparable");
	expect(memory.series.map((entry) => entry.recorded)).toEqual([false, true]);
	expect(comparedMeasurement(result, "io", executions).status).toBe(
		"unavailable",
	);
	expect(comparedMeasurement(undefined, "cpu", executions).status).toBe(
		"unavailable",
	);
});

test("elapsed time reads as a clock and durations as their two largest units", () => {
	expect(formatElapsed(0)).toBe("0:00");
	expect(formatElapsed(249_000)).toBe("4:09");
	expect(formatElapsed(3_909_000)).toBe("1:05:09");
	expect(formatDuration(7_500_000, "en")).toBe("2 hr 5 min");
	expect(formatDuration(500, "en")).toBe("0 sec");
});
