// Overlapping workloads are limited to the selected execution's project: other projects'
// executions and processes are neither listed nor counted, even on the same host.

/** At most this many overlapping executions are listed; `more` reports the rest. */
export const OVERLAP_LIMIT = 20;
/** At most this many shared nodes are listed per overlapping execution. */
export const OVERLAP_NODE_LIMIT = 20;
/** The load split filters by node, within the analytics filter's value limit. */
export const LOAD_NODE_LIMIT = 100;

export interface OverlapNode {
	nodeId: string;
	/** The node's collector hostname when the project still knows it. */
	hostname: string | null;
}
export interface OverlappingExecution {
	executionKey: string;
	name: string;
	workloadVersion: string | null;
	/** Shared nodes, all of them when `nodeCount` is at most `OVERLAP_NODE_LIMIT`. */
	nodes: OverlapNode[];
	nodeCount: number;
	/** The first and last moment of overlap across the shared nodes, [from, to). */
	from: Date;
	to: Date;
}
export interface ExecutionOverlaps {
	executions: OverlappingExecution[];
	more: boolean;
}

export const LOAD_SHARES = ["execution", "others", "unlabelled"] as const;
export type LoadShare = (typeof LOAD_SHARES)[number];
export const LOAD_METRICS = {
	cpu: {
		metric: "process.cpu.time",
		calculation: "rate",
		combine: "sum",
	},
	memory: {
		metric: "recount.process.memory.rss",
		calculation: "avg",
		combine: "sum",
	},
} as const;
export type LoadMetric = keyof typeof LOAD_METRICS;

export interface LoadSeries {
	share: LoadShare;
	points: { bucketMs: number; value: number | null }[];
}
export interface ExecutionLoad {
	from: Date;
	to: Date;
	bucketSeconds: number;
	nodeCount: number;
	/** Null when the project has no such process metric. */
	metrics: Record<
		LoadMetric,
		{ unit: string; calculation: "rate" | "avg"; series: LoadSeries[] } | null
	>;
}
