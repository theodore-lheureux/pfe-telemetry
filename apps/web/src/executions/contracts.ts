import type { ProjectReference } from "../organizations/contracts";

export interface ExecutionReference extends ProjectReference {
	executionKey: string;
}
export interface ExecutionSummary extends ExecutionReference {
	name: string;
	workloadVersion: string | null;
	parameters: Record<string, string>;
	nodeCount: number;
	participantCount: number;
	environmentVariables: string[];
	firstSeen: Date;
	lastSeen: Date;
}
export interface ExecutionFact {
	nodeId: string;
	participantId: string;
	factId: string;
	kind: 1 | 2;
	processResourceId: string | null;
	namespaceId: string | null;
	pid: number | null;
	startTimeTicks: string | null;
	ownerUid: number | null;
	environmentVariable: string;
	firstSeen: Date;
	lastSeen: Date;
	ended: Date | null;
}
export interface ExecutionDetail extends ExecutionSummary {
	facts: ExecutionFact[];
}
export interface TelemetryPoint {
	bucketMs: number;
	timeMs: string;
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
