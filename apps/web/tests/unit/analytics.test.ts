import { expect, test } from "bun:test";
import {
	attributeLabel,
	metricLabel,
	unitLabel,
} from "../../src/analytics/metric-names";
import { mergeNodes, nodesMetric } from "../../src/analytics/overview/combine";
import {
	metricBehavior,
	parseField,
	parseOverviewInput,
	parseQuery,
} from "../../src/analytics/validation";
import { InputError } from "../../src/lib/input-error";

const base = {
	shape: "timeseries",
	range: { last: "1h" },
	interval: "1m",
	measures: [
		{
			name: "cpu",
			metric: "recount.node.cpu.time",
			calculation: "rate",
			combine: "sum",
		},
	],
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

test("fields are core names or unambiguous attribute lookups", () => {
	expect(parseField("node")).toEqual({ type: "core", name: "node" });
	expect(parseField('resource.attributes["host.name"]')).toEqual({
		type: "attribute",
		scope: "resource",
		key: "host.name",
	});
	for (const field of [
		"metric_points.project_id",
		'attributes["a"b"]',
		'attributes["a\\"]',
		'attributes[""]',
		"value",
	])
		expect(reason(() => parseField(field))).toBe("INVALID_QUERY");
});

test("queries are bounded and structurally valid before reaching ClickHouse", () => {
	expect(parseQuery(base).measures[0].filters).toEqual([]);
	expect(
		reason(() =>
			parseQuery({
				...base,
				range: { from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
			}),
		),
	).toBe("INVALID_TIME_RANGE");
	// 30 days at one-minute buckets would exceed the bucket limit.
	expect(reason(() => parseQuery({ ...base, range: { last: "30d" } }))).toBe(
		"INVALID_TIME_RANGE",
	);
	expect(
		reason(() =>
			parseQuery({
				...base,
				filters: [{ field: "node", op: "eq", values: ["a", "b"] }],
			}),
		),
	).toBe("INVALID_QUERY");
	expect(
		reason(() =>
			parseQuery({ ...base, measures: [base.measures[0], base.measures[0]] }),
		),
	).toBe("INVALID_QUERY");
	expect(
		reason(() =>
			parseQuery({ ...base, groupBy: ["node", "host", "scope.name"] }),
		),
	).toBe("INVALID_QUERY");
	// 26 broken-down series of 51 groups over 288 buckets would return too many rows.
	const letters = Array.from({ length: 26 }, (_, index) => ({
		...base.measures[0],
		name: String.fromCharCode(65 + index),
	}));
	expect(
		reason(() =>
			parseQuery({
				...base,
				range: { last: "24h" },
				interval: "5m",
				measures: letters,
				groupBy: ["node"],
				limit: 50,
			}),
		),
	).toBe("INVALID_QUERY");
	expect(
		parseQuery({
			...base,
			range: { last: "24h" },
			interval: "5m",
			measures: letters,
			groupBy: ["node"],
			limit: 25,
		}).measures,
	).toHaveLength(26);
});

test("metric behavior follows OTLP kind, temporality and monotonicity", () => {
	expect(metricBehavior(1, 0, null)).toBe("gauge");
	expect(metricBehavior(2, 2, true)).toBe("counter");
	expect(metricBehavior(2, 1, true)).toBe("delta");
	expect(metricBehavior(2, 2, false)).toBe("gauge");
	expect(metricBehavior(3, 2, null)).toBe("unsupported");
});

test("known metrics get friendly names; others keep their technical names", () => {
	expect(metricLabel("recount.node.cpu.time")).toBe("Node CPU time");
	expect(metricLabel("vendor.custom.metric")).toBe("vendor.custom.metric");
	expect(attributeLabel("cpu.mode")).toBe("CPU mode");
	expect(attributeLabel("custom.key")).toBe("custom.key");
	expect(unitLabel("By")).toBe("bytes");
	expect(unitLabel("{process}")).toBe("process");
	expect(unitLabel("1")).toBe("");
	expect(unitLabel("ms")).toBe("ms");
});

test("the overview takes any range an analysis accepts", () => {
	const reference = {
		organizationId: "org",
		projectId: "11111111-1111-4111-8111-111111111111",
		section: "cpu",
	};
	expect(
		parseOverviewInput({ ...reference, range: { last: "24h" } }).range,
	).toEqual({
		last: "24h",
	});
	expect(
		parseOverviewInput({
			...reference,
			range: { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" },
		}).range,
	).toEqual({
		from: "2026-11-01T00:00:00.000Z",
		to: "2026-11-02T00:00:00.000Z",
	});
	expect(
		reason(() =>
			parseOverviewInput({
				...reference,
				range: { from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
			}),
		),
	).toBe("INVALID_TIME_RANGE");
	expect(
		reason(() =>
			parseOverviewInput({
				...reference,
				section: "disk",
				range: { last: "1h" },
			}),
		),
	).toBe("INVALID_QUERY");
});

test("the overview counts nodes reporting CPU or memory and merges their rows", () => {
	const section = (
		name: "cpu" | "memory" | "processes",
		current: Record<string, number[]>,
		values: Record<string, number>,
	) => ({
		section: name,
		bucketSeconds: 60,
		metric: {
			stat: name,
			current: null,
			previous: null,
			series: [0, 60_000].map((bucketMs) => ({ bucketMs, value: null })),
			previousSeries: [],
		},
		reporting: { current, previous: {} },
		nodes: Object.entries(values).map(([id, value]) => ({
			id,
			hostname: null,
			values: name === "processes" ? { processes: value } : { [name]: value },
		})),
	});
	const sections = [
		section("cpu", { a: [0, 60_000] }, { a: 0.2 }),
		section("memory", { b: [60_000] }, { b: 0.5 }),
		section("processes", { c: [0] }, { a: 40, c: 3 }),
	];
	const nodes = nodesMetric(sections);
	expect(nodes?.current).toBe(2);
	expect(nodes?.previous).toBeNull();
	expect(nodes?.series.map((point) => point.value)).toEqual([1, 2]);
	expect(nodesMetric([sections[2]])).toBeNull();
	expect(mergeNodes(sections)).toEqual([
		{ id: "a", hostname: null, values: { cpu: 0.2, processes: 40 } },
		{ id: "b", hostname: null, values: { memory: 0.5 } },
		{ id: "c", hostname: null, values: { processes: 3 } },
	]);
});
