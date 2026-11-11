import { expect, test } from "bun:test";
import { Root } from "protobufjs/light";
import { displayedActivity } from "../../src/activity/activity-state";
import { activityNode, decodePacket } from "../../src/activity/codec.server";
import { parseColumns } from "../../src/activity/columns";
import { activityNumberFormat } from "../../src/activity/format";
import generated from "../../src/activity/generated/descriptors.json";
import {
	emptyLive,
	liveSnapshot,
	packetRate,
} from "../../src/activity/live-state";
import {
	parseExplorer,
	parsePacket,
	parsePoint,
} from "../../src/activity/validation";
import { MutationFailure } from "../../src/lib/operation-result";

const root = Root.fromJSON(generated.schema);
const raw = root.lookupType("recount.telemetry.RawRecord"),
	metrics = root.lookupType(
		"opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
	);
const project = "019a4790-d1da-7000-8000-000000000002",
	other = "019a4790-d1da-7000-8000-000000000003";
const reference = { organizationId: "org", projectId: project };
test("activity scalar formatting retains Float64 precision and exact Int64 values in both locales", () => {
	expect(activityNumberFormat("en")(0.000012345678901234568)).toBe(
		"0.000012345678901234568",
	);
	expect(activityNumberFormat("en")("9223372036854775807")).toBe(
		"9,223,372,036,854,775,807",
	);
	expect(activityNumberFormat("fr")(0.000012345678901234568)).toBe(
		"0,000012345678901234568",
	);
});
function packet(
	projectId = project,
	measured = Date.now(),
	received = Date.now(),
	id = crypto.randomUUID(),
) {
	const otlp = metrics
		.encode(
			metrics.fromObject({
				resource_metrics: [
					{
						resource: {
							attributes: [
								{ key: "host.name", value: { string_value: "test-node" } },
							],
						},
						scope_metrics: [
							{
								metrics: [
									{
										name: "custom.measurement",
										gauge: {
											data_points: [
												{
													time_unix_nano: (
														BigInt(measured) * 1000000n
													).toString(),
													as_int: "9223372036854775807",
												},
											],
										},
									},
								],
							},
						],
					},
				],
			}),
		)
		.finish();
	const bytes = raw
		.encode(
			raw.fromObject({
				security: { project_id: projectId, source_id: "source" },
				record_id: id,
				received_unix_nano: (BigInt(received) * 1000000n).toString(),
				otlp_request: otlp,
				bindings: [
					{
						original_resource: 0,
						context: { resource: { id: "node", kind: 1 }, host_id: "node" },
					},
				],
				delivery: { ingestion_peer_address: "192.0.2.1:4317" },
			}),
		)
		.finish();
	return decodePacket(Buffer.from(bytes), 2, "9007199254740993");
}

test("live decoding uses current descriptors, preserves integer precision and separates packets from points", () => {
	const decoded = packet();
	expect(decoded.detail.summary).toMatchObject({
		resources: 1,
		metrics: 1,
		points: 1,
		offset: "9007199254740993",
		partition: 2,
	});
	expect(decoded.detail.summary.nodes[0]).toEqual(
		activityNode(project, "node", "test-node"),
	);
	expect(JSON.stringify(decoded.detail.payload)).toContain(
		"9223372036854775807",
	);
	expect(decoded.detail.delivery).toEqual({
		ingestion_peer_address: "192.0.2.1:4317",
	});
	expect(decoded.detail.summary.receivedAt).toBeInstanceOf(Date);
	expect(() => decodePacket(Buffer.alloc(6291457), 0, "1")).toThrow();
	expect(() => decodePacket(Buffer.from([0xff]), 0, "1")).toThrow();
});

test("browser counters do not count old queued measurements as reporting", () => {
	const now = Date.now();
	const event = (measured: number) => {
		const decoded = packet(project, measured, now);
		return {
			projectId: project,
			summary: decoded.detail.summary,
			nodeTimes: decoded.nodeTimes,
			limited: false,
		};
	};
	expect(
		liveSnapshot([event(now)], new Date(now), new Date(now)).reportingNodes,
	).toBe(1);
	expect(
		liveSnapshot([event(now - 120000)], new Date(now), new Date(now))
			.reportingNodes,
	).toBe(0);
	expect(
		liveSnapshot([event(now + 31000)], new Date(now), new Date(now))
			.reportingNodes,
	).toBe(0);
	expect(activityNode(project, "node", "name").fingerprint).not.toBe(
		activityNode(other, "node", "name").fingerprint,
	);
});

test("activity cursors bind time bounds and reject invalid identifiers without coercing UInt64 timestamps", () => {
	const to = new Date(),
		from = new Date(to.getTime() - 3600000),
		timeNs = (BigInt(to.getTime()) * 1000000n).toString();
	expect(
		parseExplorer({
			...reference,
			cursor: { to, from, timeNs, sampleId: "aa".repeat(32) },
		}).cursor?.to,
	).toBe(to);
	expect(() =>
		parseExplorer({
			...reference,
			cursor: {
				to,
				from: new Date(to.getTime() + 1),
				timeNs,
				sampleId: "aa".repeat(32),
			},
		}),
	).toThrow();
	expect(() =>
		parseExplorer({
			...reference,
			cursor: { to, from, timeNs: "1", sampleId: "aa".repeat(32) },
		}),
	).toThrow();
	expect(() =>
		parsePoint({
			...reference,
			sourceId: "source",
			resourceId: "node",
			metricName: "metric",
			timeNs: "18446744073709551616",
			sampleId: "aa".repeat(32),
		}),
	).toThrow();
	expect(() => parsePacket({ ...reference, packetId: "\nsecret" })).toThrow();
	expect(() => parseExplorer({ ...reference, projectId: "other" })).toThrow();
});

test("paused rows survive a failed in-flight refresh but disappear on authorization failure", () => {
	const frozen = emptyLive();
	expect(
		displayedActivity({
			paused: true,
			frozen,
			error: new Error("Network interrupted"),
		}),
	).toBe(frozen);
	expect(
		displayedActivity({
			paused: false,
			frozen,
			error: new Error("Network interrupted"),
		}),
	).toBeUndefined();
	for (const code of ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"] as const)
		expect(
			displayedActivity({
				paused: true,
				frozen,
				error: new MutationFailure({ code, message: code }),
			}),
		).toBeUndefined();
});

test("packet rate is per minute from the first seconds of a connection", () => {
	const now = Date.UTC(2026, 10, 11, 12, 0, 0);
	const every = (seconds: number, count: number) =>
		Array.from({ length: count }, (_, index) => now - index * seconds * 1000);
	// Twenty seconds in, one packet every 2 s is already 30 per minute.
	expect(packetRate(every(2, 10), new Date(now - 20000), new Date(now))).toBe(
		30,
	);
	// After a full minute the last 60 s are counted and older arrivals drop out.
	expect(packetRate(every(2, 60), new Date(now - 600000), new Date(now))).toBe(
		30,
	);
	// A single early packet does not read as 60 per second.
	expect(packetRate([now], new Date(now - 1000), new Date(now))).toBe(6);
});

test("Explorer filters are validated and intervals must be ordered and in the past", () => {
	const to = new Date(),
		from = new Date(to.getTime() - 21_600_000),
		cursor = {
			to,
			from,
			timeNs: (BigInt(to.getTime()) * 1000000n).toString(),
			sampleId: "aa".repeat(32),
		};
	expect(parseExplorer({ ...reference, from, to, cursor }).cursor?.from).toBe(
		from,
	);
	expect(() =>
		parseExplorer({ ...reference, cursor: { ...cursor, from: to } }),
	).toThrow();
	expect(() => parseExplorer({ ...reference, from: to, to: from })).toThrow();
	expect(() =>
		parseExplorer({ ...reference, to: new Date(Date.now() + 3_600_000) }),
	).toThrow();
	expect(() => parseExplorer({ ...reference, from: "yesterday" })).toThrow();
	expect(
		parseExplorer({
			...reference,
			metric: "recount.node.cpu.time",
			filters: [
				{ field: 'attributes["cpu.mode"]', op: "eq", values: ["user"] },
			],
		}).filters,
	).toHaveLength(1);
	expect(() =>
		parseExplorer({
			...reference,
			filters: [{ field: "metric_points.project_id", op: "eq", values: ["x"] }],
		}),
	).toThrow();
	expect(() =>
		parseExplorer({ ...reference, metric: "bad\nmetric" }),
	).toThrow();
	expect(() =>
		parseExplorer({
			...reference,
			filters: Array.from({ length: 9 }, () => ({
				field: 'attributes["cpu.mode"]',
				op: "exists",
			})),
		}),
	).toThrow();
});

test("Explorer column sets are bounded, unique and use attribute fields", () => {
	expect(
		parseColumns([
			{ field: "metric" },
			{ field: 'resource.attributes["host.name"]', label: " Host " },
		]),
	).toEqual([
		{ field: "metric" },
		{ field: 'resource.attributes["host.name"]', label: "Host" },
	]);
	expect(() => parseColumns([])).toThrow();
	expect(() =>
		parseColumns([{ field: "metric" }, { field: "metric" }]),
	).toThrow();
	expect(() => parseColumns([{ field: "node" }, { field: "host" }])).toThrow();
	expect(() => parseColumns([{ field: "project_id" }])).toThrow();
	expect(() => parseColumns([{ field: "metric", label: "a\nb" }])).toThrow();
	expect(() =>
		parseColumns(
			Array.from({ length: 11 }, (_, index) => ({
				field: `attributes["key${index}"]`,
			})),
		),
	).toThrow();
	expect(() => parseExplorer({ ...reference, fields: ["node"] })).toThrow();
	expect(
		parseExplorer({ ...reference, fields: ['attributes["cpu.mode"]'] }).fields,
	).toEqual(['attributes["cpu.mode"]']);
});
