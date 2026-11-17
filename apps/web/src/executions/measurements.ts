import type { Measure } from "../analytics/contracts";

/**
 * What an execution page charts: the CPU, memory and disk I/O of the execution's member
 * processes. Execution filters only match process points, so node-wide metrics never
 * appear here.
 */
export const EXECUTION_MEASURES = [
	{
		name: "cpu",
		metric: "process.cpu.time",
		calculation: "rate",
		combine: "sum",
	},
	{
		name: "memory",
		metric: "recount.process.memory.rss",
		calculation: "last",
		combine: "sum",
	},
	{
		name: "io",
		metric: "process.disk.io",
		calculation: "rate",
		combine: "sum",
	},
] as const satisfies readonly Measure[];
