import { createHash } from "node:crypto";
import { Root } from "protobufjs/light";
import type {
	ActivityNode,
	JsonObject,
	JsonValue,
	LiveEvent,
	PacketDetail,
} from "./contracts";
import generated from "./generated/descriptors.json";

const root = Root.fromJSON(generated.schema);
const rawType = root.lookupType("recount.telemetry.RawRecord");
const requestType = root.lookupType(
	"opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
);
const lineageType = root.lookupType("recount.telemetry.PointLineage");
const notificationType = root.lookupType("recount.telemetry.LiveNotification");
const options = {
	longs: String,
	enums: String,
	bytes: String,
	arrays: true,
	objects: true,
};

export function object(value: JsonValue | undefined): JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}
function array(value: JsonValue | undefined): JsonValue[] {
	return Array.isArray(value) ? value : [];
}
function string(value: JsonValue | undefined) {
	return typeof value === "string" ? value : "";
}
function attributes(value: JsonValue | undefined, key: string) {
	return string(
		object(
			object(array(value).find((entry) => object(entry).key === key)).value,
		).string_value,
	).slice(0, 128);
}
export function activityNode(
	project: string,
	id: string,
	name: string,
): ActivityNode {
	return {
		id,
		name: name || id,
		fingerprint: createHash("sha256")
			.update(JSON.stringify([project, id]))
			.digest("hex")
			.slice(0, 8),
	};
}
export function nanosecondsDate(value: string): Date {
	if (!/^[0-9]{1,20}$/.test(value))
		throw new Error("Invalid telemetry timestamp");
	const date = new Date(Number(BigInt(value) / 1000000n));
	if (!Number.isFinite(date.getTime()))
		throw new Error("Invalid telemetry timestamp");
	return date;
}
export function decodeLineage(hex: string): JsonObject {
	return lineageType.toObject(
		lineageType.decode(Buffer.from(hex, "hex")),
		options,
	) as JsonObject;
}

function preview(value: JsonValue): { value: JsonValue; truncated: boolean } {
	let remaining = 64000,
		items = 2000,
		truncated = false;
	const visit = (entry: JsonValue, depth: number): JsonValue => {
		if (remaining <= 0 || --items <= 0 || depth > 16) {
			truncated = true;
			return "…";
		}
		if (typeof entry === "string") {
			const clipped = entry.slice(0, Math.min(remaining, 4096));
			remaining -= Buffer.byteLength(clipped);
			if (clipped.length !== entry.length) truncated = true;
			return clipped;
		}
		if (Array.isArray(entry)) {
			if (entry.length > 64) truncated = true;
			return entry.slice(0, 64).map((item) => visit(item, depth + 1));
		}
		if (entry && typeof entry === "object") {
			const entries = Object.entries(entry);
			if (entries.length > 128) truncated = true;
			return Object.fromEntries(
				entries.slice(0, 128).map(([key, item]) => {
					remaining -= Buffer.byteLength(key);
					return [key, visit(item, depth + 1)];
				}),
			);
		}
		remaining -= 16;
		return entry;
	};
	return { value: visit(value, 0), truncated };
}

export interface DecodedPacket {
	projectId: string;
	detail: PacketDetail;
	nodeTimes: { id: string; time: number }[];
}
const POINT_KINDS = [
	"gauge",
	"sum",
	"histogram",
	"exponential_histogram",
	"summary",
];

/** Metrics, data points and the latest point time (ms) in one OTLP resource. */
function countMetrics(resource: JsonObject) {
	let metrics = 0,
		points = 0,
		latest = 0;
	for (const scope of array(resource.scope_metrics))
		for (const metric of array(object(scope).metrics)) {
			metrics++;
			const data = object(metric);
			for (const kind of POINT_KINDS)
				for (const point of array(object(data[kind]).data_points)) {
					points++;
					const time = nanosecondsDate(
						string(object(point).time_unix_nano),
					).getTime();
					latest = Math.max(latest, time);
				}
		}
	return { metrics, points, latest };
}

export function decodePacket(
	bytes: Buffer,
	partition: number,
	offset: string,
	expectedProject?: string,
): DecodedPacket {
	if (bytes.length > 6291456)
		throw new Error("Raw telemetry record exceeds view budget");
	const rawMessage = rawType.decode(bytes);
	const raw = rawType.toObject(rawMessage, options) as JsonObject;
	const security = object(raw.security),
		projectId = string(security.project_id),
		sourceId = string(security.source_id);
	if (
		!/^[0-9a-f-]{36}$/i.test(projectId) ||
		!sourceId ||
		sourceId.length > 128 ||
		!string(raw.record_id)
	)
		throw new Error("Invalid retained telemetry scope");
	if (expectedProject && projectId !== expectedProject)
		throw new Error("Packet not found");
	const payload = requestType.toObject(
		requestType.decode(Buffer.from(string(raw.otlp_request), "base64")),
		options,
	) as JsonObject;
	const bindings = new Map(
		array(raw.bindings).map((entry) => {
			const binding = object(entry);
			return [Number(binding.original_resource ?? 0), object(binding.context)];
		}),
	);
	const nodes = new Map<string, ActivityNode>(),
		nodeTimes = new Map<string, number>();
	let metrics = 0,
		points = 0,
		latest = 0;
	const resources = array(payload.resource_metrics);
	for (const [index, entry] of resources.entries()) {
		const resource = object(entry),
			context = bindings.get(index) ?? {},
			reference = object(context.resource);
		const hostId =
			string(context.host_id) ||
			(reference.kind === "HOST" ? string(reference.id) : "");
		if (hostId)
			nodes.set(
				hostId,
				activityNode(
					projectId,
					hostId,
					attributes(object(resource.resource).attributes, "host.name"),
				),
			);
		const counted = countMetrics(resource);
		metrics += counted.metrics;
		points += counted.points;
		const resourceLatest = counted.latest;
		latest = Math.max(latest, resourceLatest);
		if (hostId)
			nodeTimes.set(
				hostId,
				Math.max(nodeTimes.get(hostId) ?? 0, resourceLatest),
			);
	}
	const clipped = preview(payload);
	const metadata = preview({
		security,
		record_id: raw.record_id ?? null,
		received_unix_nano: raw.received_unix_nano ?? null,
		batch: raw.batch ?? null,
		payload_kind: raw.payload_kind ?? null,
		bindings: raw.bindings ?? [],
	});
	return {
		projectId,
		nodeTimes: [...nodeTimes].map(([id, time]) => ({ id, time })),
		detail: {
			summary: {
				id: string(raw.record_id),
				sourceId,
				receivedAt: nanosecondsDate(string(raw.received_unix_nano)),
				measuredAt: latest ? new Date(latest) : null,
				nodes: [...nodes.values()].slice(0, 64),
				resources: resources.length,
				metrics,
				points,
				bytes: bytes.length,
				partition,
				offset,
			},
			delivery: object(raw.delivery),
			payload: object(clipped.value),
			metadata: object(metadata.value),
			truncated: clipped.truncated || metadata.truncated,
		},
	};
}

export function liveShard(projectId: string, partitions: number) {
	return (
		createHash("sha256").update(projectId).digest().readUInt32BE(0) % partitions
	);
}

export function decodeNotification(bytes: Buffer): LiveEvent {
	if (bytes.length > 32768) throw new Error("Notification exceeds byte bound");
	const value = notificationType.toObject(notificationType.decode(bytes), {
		...options,
		defaults: true,
	}) as JsonObject;
	const projectId = string(value.project_id);
	if (
		!/^[0-9a-f-]{36}$/i.test(projectId) ||
		!string(value.record_id) ||
		!string(value.source_id)
	)
		throw new Error("Invalid notification scope");
	const nodes = array(value.nodes);
	if (nodes.length > 64) throw new Error("Notification exceeds node bound");
	const offset = string(value.raw_offset);
	if (
		!/^(0|[1-9][0-9]{0,18})$/.test(offset) ||
		BigInt(offset) > 9223372036854775807n
	)
		throw new Error("Invalid raw offset");
	const time = (value: JsonValue | undefined) => nanosecondsDate(string(value));
	return {
		projectId,
		summary: {
			id: string(value.record_id),
			sourceId: string(value.source_id),
			receivedAt: time(value.received_unix_nano),
			measuredAt:
				string(value.measured_unix_nano) === "0"
					? null
					: time(value.measured_unix_nano),
			nodes: nodes.map((n) =>
				activityNode(projectId, string(object(n).id), string(object(n).name)),
			),
			resources: Number(value.resources),
			metrics: Number(value.metrics),
			points: Number(value.points),
			bytes: Number(value.bytes),
			partition: Number(value.raw_partition),
			offset,
		},
		nodeTimes: nodes.map((n) => ({
			id: string(object(n).id),
			time: time(object(n).measured_unix_nano).getTime(),
		})),
		limited: value.nodes_truncated === true,
	};
}
