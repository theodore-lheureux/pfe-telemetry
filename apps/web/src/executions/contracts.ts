import type { ProjectReference } from "../organizations/contracts";

export interface ExecutionReference extends ProjectReference {
	executionId: string;
}
export interface CreateExecutionInput extends ProjectReference {
	requestId: string;
	name: string;
	nodeId: string;
	hostId: string | null;
	startedAt: string;
	endedAt: string;
}
export interface ExecutionSummary extends ExecutionReference {
	name: string;
	sourceId: string;
	hostId: string | null;
	startedAt: Date;
	endedAt: Date;
	createdAt: Date;
	createdBy: string | null;
	canEdit: boolean;
}
export interface TelemetryInput extends ExecutionReference {
	from?: string;
	to?: string;
	buckets?: number;
}
export interface TelemetryPoint {
	bucketMs: number;
	timeNs: string;
	flags: number;
	integer: string | null;
	double: number | null;
}
export interface TelemetrySeries {
	id: string;
	metric: string;
	unit: "s" | "By";
	hostId: string | null;
	cpuMode: string | null;
	segments: { id: string; points: TelemetryPoint[] }[];
}
export interface TelemetryResult {
	from: Date;
	to: Date;
	bucketMs: number;
	series: TelemetrySeries[];
}
