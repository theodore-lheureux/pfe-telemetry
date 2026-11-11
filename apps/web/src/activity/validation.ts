import { MAX_FILTERS } from "../analytics/contracts";
import {
	parseField,
	parseFilter,
	parseMetricName,
} from "../analytics/validation";
import { parseProjectReference } from "../organizations/validation";
import { MAX_ATTRIBUTE_COLUMNS, parseColumns } from "./columns";
import type { SaveColumnsInput } from "./columns.server";
import type { ExplorerInput, PacketInput, PointInput } from "./contracts";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid activity request");
	return value as Record<string, unknown>;
}
function text(value: unknown, limit: number) {
	if (
		typeof value !== "string" ||
		!value.length ||
		value.length > limit ||
		Array.from(value).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		throw new Error("Invalid activity identifier");
	return value;
}
function sample(value: unknown) {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value))
		throw new Error("Invalid sample identifier");
	return value.toUpperCase();
}
function nanos(value: unknown) {
	if (
		typeof value !== "string" ||
		!/^[0-9]{1,20}$/.test(value) ||
		BigInt(value) <= 0n ||
		BigInt(value) > 18446744073709551615n
	)
		throw new Error("Invalid measurement timestamp");
	return value;
}
function optionalTime(value: unknown) {
	if (value === undefined) return undefined;
	if (
		!(value instanceof Date) ||
		!Number.isFinite(value.getTime()) ||
		value.getTime() < 0
	)
		throw new Error("Invalid activity time");
	return value;
}
export function parseExplorer(value: unknown): ExplorerInput {
	const input = record(value),
		reference = parseProjectReference(value);
	const from = optionalTime(input.from),
		to = optionalTime(input.to);
	if (
		(to && to.getTime() > Date.now() + 30000) ||
		(from && from.getTime() >= (to ?? new Date()).getTime())
	)
		throw new Error("Invalid activity interval");
	if (
		input.filters !== undefined &&
		(!Array.isArray(input.filters) || input.filters.length > MAX_FILTERS)
	)
		throw new Error("Invalid activity filters");
	const filters = ((input.filters as unknown[] | undefined) ?? []).map(
		parseFilter,
	);
	if (
		input.fields !== undefined &&
		(!Array.isArray(input.fields) ||
			input.fields.length > MAX_ATTRIBUTE_COLUMNS ||
			new Set(input.fields).size !== input.fields.length ||
			!input.fields.every(
				(field) =>
					typeof field === "string" && parseField(field).type === "attribute",
			))
	)
		throw new Error("Invalid activity fields");
	const parsed: ExplorerInput = {
		...reference,
		...(input.fields?.length ? { fields: input.fields as string[] } : {}),
		...(from ? { from } : {}),
		...(to ? { to } : {}),
		filters,
		...(input.metric === undefined
			? {}
			: { metric: parseMetricName(input.metric) }),
	};
	if (input.cursor === undefined) return parsed;
	const cursor = record(input.cursor);
	if (
		!(cursor.from instanceof Date) ||
		!(cursor.to instanceof Date) ||
		!Number.isFinite(cursor.from.getTime()) ||
		!Number.isFinite(cursor.to.getTime()) ||
		cursor.from.getTime() < 0 ||
		cursor.from.getTime() >= cursor.to.getTime() ||
		cursor.to.getTime() > Date.now() + 30000
	)
		throw new Error("Invalid activity cursor");
	const timeNs = nanos(cursor.timeNs);
	if (
		BigInt(timeNs) < BigInt(cursor.from.getTime()) * 1000000n ||
		BigInt(timeNs) > BigInt(cursor.to.getTime()) * 1000000n
	)
		throw new Error("Cursor outside activity interval");
	return {
		...parsed,
		cursor: {
			from: cursor.from,
			to: cursor.to,
			timeNs,
			sampleId: sample(cursor.sampleId),
		},
	};
}
export function parsePoint(value: unknown): PointInput {
	const input = record(value);
	return {
		...parseProjectReference(value),
		sampleId: sample(input.sampleId),
		sourceId: text(input.sourceId, 128),
		resourceId: text(input.resourceId, 128),
		metricName: text(input.metricName, 1024),
		timeNs: nanos(input.timeNs),
	};
}
export function parsePacket(value: unknown): PacketInput {
	const input = record(value),
		packetId = text(input.packetId, 128);
	if (
		!Number.isInteger(input.partition) ||
		Number(input.partition) < 0 ||
		Number(input.partition) > 4095 ||
		typeof input.offset !== "string" ||
		!/^(0|[1-9][0-9]{0,18})$/.test(input.offset) ||
		BigInt(input.offset) > 9223372036854775807n
	)
		throw new Error("Invalid packet location");
	return {
		...parseProjectReference(value),
		packetId,
		partition: Number(input.partition),
		offset: input.offset,
	};
}

export function parseSaveColumns(value: unknown): SaveColumnsInput {
	const input = record(value);
	if (typeof input.asDefault !== "boolean")
		throw new Error("Invalid column request");
	return {
		...parseProjectReference(value),
		columns: parseColumns(input.columns),
		asDefault: input.asDefault,
	};
}
