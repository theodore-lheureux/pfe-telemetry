import { expect, test } from "bun:test";
import idle from "./fixtures/idle.json";
import collector from "./fixtures/collector.json";
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
		const body = first.at(start, start);
		const host = (payload) =>
			payload.resourceMetrics[0].resource.attributes.find(
				({ key }) => key === "host.id",
			).value.stringValue;
		expect(host(body)).toBe(a.machineId);
		expect(host(second.at(start, start))).toBe(b.machineId);
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
		const later = points(first.at(start + 1000, start));
		for (const [i, point] of later.entries()) {
			expect(BigInt(point.timeUnixNano) - BigInt(earlier[i].timeUnixNano)).toBe(
				1_000_000_000n,
			);
			expect(point.startTimeUnixNano).toBe(earlier[i].startTimeUnixNano);
			expect(point.attributes).toEqual(earlier[i].attributes);
		}
	},
);
