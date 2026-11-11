import { expect, test } from "bun:test";
import {
	attributeLabel,
	metricLabel,
	unitLabel,
} from "../../src/analytics/metric-names";
import {
	metricBehavior,
	parseField,
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
