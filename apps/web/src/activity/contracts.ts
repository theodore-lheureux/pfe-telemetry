import type { ProjectReference } from "../organizations/contracts";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface ActivityNode {
	id: string;
	name: string;
	fingerprint: string;
}
export interface PacketSummary {
	id: string;
	sourceId: string;
	receivedAt: Date;
	measuredAt: Date | null;
	nodes: ActivityNode[];
	resources: number;
	metrics: number;
	points: number;
	bytes: number;
	partition: number;
	offset: string;
}
export interface LiveEvent {
	projectId: string;
	summary: PacketSummary;
	nodeTimes: { id: string; time: number }[];
	limited: boolean;
}
export interface PacketDetail {
	summary: PacketSummary;
	delivery: JsonObject;
	payload: JsonObject;
	metadata: JsonObject;
	truncated: boolean;
}
export interface LiveSnapshot {
	packets: PacketSummary[];
	reportingNodes: number;
	packetsLastMinute: number;
	observerStartedAt: Date;
	checkedAt: Date;
	lastReceivedAt: Date | null;
	status: "connecting" | "connected" | "disconnected";
	limited: boolean;
	/** Packets received on this connection, including ones no longer retained. */
	received: number;
}
export interface PointReference {
	sampleId: string;
	sourceId: string;
	resourceId: string;
	metricName: string;
	timeNs: string;
}
export interface PointSummary extends PointReference {
	node: ActivityNode | null;
	resourceKind: number;
	kind: number;
	value: string | number | null;
	count: string | null;
	unit: string;
	measuredAt: Date;
	flags: number;
	scopeName: string;
	scopeVersion: string;
}
export interface PointCursor {
	from: Date;
	to: Date;
	timeNs: string;
	sampleId: string;
}
export interface PointPage {
	points: PointSummary[];
	nextCursor: PointCursor | null;
	from: Date;
	to: Date;
}
export type ExplorerInput = ProjectReference & { cursor?: PointCursor };
export type PointInput = ProjectReference & PointReference;
export type PacketInput = ProjectReference & {
	packetId: string;
	partition: number;
	offset: string;
};
export interface PointDetail {
	measurement: JsonObject;
	attributes: JsonValue[];
	resource: JsonObject;
	instrumentation: JsonObject;
	provenance: JsonObject;
	raw: JsonObject;
}
