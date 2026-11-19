import { expect, test } from "bun:test";
import collector from "./fixtures/collector.json";
import idle from "./fixtures/idle.json";
import processes from "./fixtures/processes.json";
import { preparePayload } from "./payload.js";

test.each([
	[idle, 56],
	[processes, 184],
	[collector, 1158],
])(
	"captured payload is replayable with stable per-node identity",
	(fixture, count) => {
		const a = {
			machineId: "load-a",
			boot: "00000000-0000-4000-8000-000000000001",
			epoch: "00000000-0000-4000-8000-000000000002",
		};
		const b = { ...a, machineId: "load-b" };
		const first = preparePayload(fixture, a);
		const second = preparePayload(fixture, b);
		const start = 1_800_000_000_000;
		expect(first.count).toBe(count);
		const body = first.at(start, start, 0);
		const host = (payload) =>
			payload.resourceMetrics[0].resource.attributes.find(
				({ key }) => key === "host.id",
			).value.stringValue;
		expect(host(body)).toBe(a.machineId);
		expect(host(second.at(start, start, 0))).toBe(b.machineId);
		expect(host(fixture)).toBe("fixture");
		const points = (payload) =>
			payload.resourceMetrics.flatMap((resource) =>
				resource.scopeMetrics.flatMap((scope) =>
					scope.metrics.flatMap(
						(metric) => (metric.sum ?? metric.gauge).dataPoints,
					),
				),
			);
		const earlier = points(body).map((point) => ({ ...point }));
		const later = points(first.at(start + 1000, start, 1));
		for (const [i, point] of later.entries()) {
			expect(BigInt(point.timeUnixNano) - BigInt(earlier[i].timeUnixNano)).toBe(
				1_000_000_000n,
			);
			expect(point.startTimeUnixNano).toBe(earlier[i].startTimeUnixNano);
			expect(point.attributes).toEqual(earlier[i].attributes);
		}
	},
);

const gauge = (name, unit, value) => ({
	name,
	unit,
	gauge: { dataPoints: [{ timeUnixNano: "0", ...value }] },
});
const cumulative = (value, startTimeUnixNano) => ({
	name: "counter",
	sum: {
		aggregationTemporality: 2,
		isMonotonic: true,
		dataPoints: [{ timeUnixNano: "0", startTimeUnixNano, ...value }],
	},
});
const histogram = {
	count: "3",
	sum: 12,
	bucketCounts: ["1", "2"],
	explicitBounds: [3],
};
const samples = {
	resourceMetrics: [
		{
			resource: { attributes: [] },
			scopeMetrics: [
				{
					metrics: [
						gauge("cpu.utilization", "1", { asDouble: 1 }),
						gauge("gpu.utilization", "%", { asInt: "99" }),
						gauge("recount.node.memory.total", "By", { asInt: "1000" }),
						gauge("recount.node.memory.available", "By", { asInt: "999" }),
						gauge("recount.process.memory.rss", "By", { asInt: "0" }),
						gauge("recount.collection.read.status", "1", { asInt: "0" }),
						cumulative({ asInt: "100" }, "-1000"),
						cumulative({ asDouble: 1 }),
						{
							histogram: { dataPoints: [{ timeUnixNano: "0", ...histogram }] },
						},
					],
				},
			],
		},
	],
};
const wall = 1_800_000_000_000;
function sequence(seed, machineId = `node-${seed}`) {
	const payload = preparePayload(samples, { seed, machineId });
	return Array.from({ length: 100 }, (_, i) =>
		payload
			.at(wall + i * 1000, wall, i)
			.resourceMetrics[0].scopeMetrics[0].metrics.map((metric) => ({
				...(metric.gauge ?? metric.sum ?? metric.histogram).dataPoints[0],
			})),
	);
}

test("walks are reproducible by node ordinal and vary between nodes and cycles", () => {
	const first = sequence(1);
	expect(sequence(1, "different-run-id")).toEqual(first);
	const other = sequence(2);
	for (const i of [0, 1, 3, 6, 7]) {
		const values = (series) =>
			series.map((points) => points[i].asDouble ?? points[i].asInt);
		expect(new Set(values(first)).size).toBeGreaterThan(1);
		expect(values(other)).not.toEqual(values(first));
	}
});

test("values stay within physical bounds and cumulative counters keep their original start", () => {
	const values = sequence(3);
	let previousInt = 100n;
	let previousDouble = 1;
	for (const [
		ratio,
		percent,
		total,
		available,
		rss,
		status,
		int,
		double,
		distribution,
	] of values) {
		expect(ratio.asDouble).toBeGreaterThanOrEqual(0.9);
		expect(ratio.asDouble).toBeLessThanOrEqual(1);
		expect(BigInt(percent.asInt)).toBeGreaterThanOrEqual(89n);
		expect(BigInt(percent.asInt)).toBeLessThanOrEqual(100n);
		expect(total.asInt).toBe("1000");
		expect(BigInt(available.asInt)).toBeLessThanOrEqual(1000n);
		expect(BigInt(rss.asInt)).toBeGreaterThanOrEqual(0n);
		expect(status.asInt).toBe("0");
		expect(BigInt(int.asInt)).toBeGreaterThanOrEqual(previousInt);
		expect(double.asDouble).toBeGreaterThanOrEqual(previousDouble);
		expect(int.startTimeUnixNano).toBe(
			String(BigInt(wall) * 1_000_000n - 1000n),
		);
		expect(double.startTimeUnixNano).toBeUndefined();
		expect(distribution).toMatchObject(histogram);
		previousInt = BigInt(int.asInt);
		previousDouble = double.asDouble;
	}
});
