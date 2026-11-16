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
	/** True while any participant fact has no end. */
	running: boolean;
	/** The first node IDs in ascending order, up to `LISTED_NODES`. */
	nodeIds: string[];
	/** Kernel owner UIDs of the participant lifecycles, ascending. */
	ownerUids: number[];
}

export const EXECUTION_STATES = ["running", "completed"] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];
/** The most values one execution filter accepts. */
export const MAX_FILTER_VALUES = 20;
/** Node IDs returned with each listed execution. */
export const LISTED_NODES = 3;

/** Every filter narrows the list; values within one filter match any of them. */
export interface ExecutionFilters {
	/** Case-insensitive text within the execution name or key. */
	q?: string;
	application?: string[];
	state?: ExecutionState;
	machine?: string[];
	owner?: number[];
	/** The period overlaps the first through last observation of the execution. */
	from?: Date;
	to?: Date;
}
export interface ExecutionListInput extends ProjectReference, ExecutionFilters {
	afterKey?: string;
}
export interface ExecutionNode {
	id: string;
	/** The enrolled hostname, or null when the node is no longer enrolled. */
	hostname: string | null;
}
export interface ExecutionPage {
	executions: ExecutionSummary[];
	nextCursor: string | null;
	/** Hostnames of the nodes listed with these executions. */
	nodes: ExecutionNode[];
}
/** Values seen in the project's executions, offered as filter choices. */
export interface ExecutionFilterOptions {
	applications: string[];
	machines: ExecutionNode[];
	owners: number[];
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
