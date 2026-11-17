import { z } from "zod";
import { parseProjectReference } from "../organizations/validation";

export const actions = [
	"create-cpu",
	"create-gpu",
	"configure",
	"move",
	"list",
	"destroy",
	"load-cpu",
	"load-gpu",
	"load-status",
	"stop-load",
] as const;
export type WorkflowAction = (typeof actions)[number];
export const playbooks: Record<WorkflowAction, string> = {
	"create-cpu": "infra/demo/create-cpu.yml",
	"create-gpu": "infra/demo/create-gpu.yml",
	configure: "infra/demo/configure.yml",
	move: "infra/demo/move.yml",
	list: "infra/demo/list.yml",
	destroy: "infra/demo/destroy.yml",
	"load-cpu": "infra/demo/load-cpu.yml",
	"load-gpu": "infra/demo/load-gpu.yml",
	"load-status": "infra/demo/load-status.yml",
	"stop-load": "infra/demo/stop-load.yml",
};

export const labSchema = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/);
export const cpuProfiles = ["cpu-hash", "cpu-primes", "cpu-pi"] as const;
export const gpuProfiles = [
	"gpu-fp32",
	"gpu-tensor",
	"gpu-memory",
	"gpu-mixed",
] as const;
export function isLoadAction(action: WorkflowAction) {
	return ["load-cpu", "load-gpu", "load-status", "stop-load"].includes(action);
}
export function workflowFleet(
	action: WorkflowAction,
	fleet?: "aws-cpu" | "gcp-gpu",
) {
	if (action === "load-cpu") return "aws-cpu";
	if (action === "load-gpu") return "gcp-gpu";
	return fleet ?? "aws-cpu";
}
const workflow = z
	.object({
		organizationId: z.string(),
		projectId: z.string(),
		action: z.enum(actions),
		lab: z.union([labSchema, z.literal("")]).default(""),
		fleet: z.enum(["aws-cpu", "gcp-gpu"]).optional(),
		count: z
			.string()
			.regex(/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/)
			.default("1"),
		ttl: z.enum(["15m", "30m", "1h", "2h", "4h"]).default("15m"),
		workload: z.enum([...cpuProfiles, ...gpuProfiles]).optional(),
		duration: z
			.string()
			.regex(/^(?:[1-9]|[1-9][0-9]|[12][0-9]{2}|300)$/)
			.default("60"),
		discard: z.boolean().default(false),
		confirmed: z.boolean().default(false),
	})
	.strict();

export function parseWorkflow(value: unknown) {
	const input = workflow.parse(value);
	if (
		!input.action.startsWith("create") &&
		input.action !== "list" &&
		!input.lab
	)
		throw new Error("An existing lab ID is required");
	if (input.action === "create-gpu" && input.count !== "1")
		throw new Error("GPU count must be one");
	if (
		(input.action.startsWith("create") ||
			input.action === "destroy" ||
			input.discard) &&
		!input.confirmed
	)
		throw new Error("Explicit confirmation is required");
	if (input.discard && input.action !== "move")
		throw new Error("Queue discard is only valid for Move");
	const fixedFleet = input.action === "load-cpu" || input.action === "load-gpu";
	if (fixedFleet && input.fleet !== undefined)
		throw new Error("Load-start fleet cannot be overridden");
	let workload = input.workload;
	if (input.action === "load-cpu") {
		workload ??= "cpu-hash";
		if (!(cpuProfiles as readonly string[]).includes(workload))
			throw new Error("Invalid CPU profile");
	} else if (input.action === "load-gpu") {
		workload ??= "gpu-mixed";
		if (!(gpuProfiles as readonly string[]).includes(workload))
			throw new Error("Invalid GPU profile");
	} else if (workload !== undefined)
		throw new Error("Profiles are only valid for load starts");
	return {
		...input,
		workload,
		fleet: fixedFleet ? undefined : workflowFleet(input.action, input.fleet),
		...parseProjectReference(input),
	};
}
export type WorkflowInput = ReturnType<typeof parseWorkflow>;

export function survey(input: WorkflowInput) {
	const values: Record<string, string> = {};
	if (input.lab && input.action !== "list") values.DEMO_LAB = input.lab;
	if (input.action.startsWith("create")) {
		Object.assign(values, {
			DEMO_COUNT: input.count,
			DEMO_TTL: input.ttl,
			DEMO_COST: input.action === "create-cpu" ? "on-demand" : "spot-only",
			DEMO_PRESET: input.action === "create-cpu" ? "t4g-nano" : "gpu-l4",
		});
	} else if (input.action === "load-cpu" || input.action === "load-gpu") {
		values.DEMO_WORKLOAD =
			input.workload ??
			(input.action === "load-cpu" ? "cpu-hash" : "gpu-mixed");
		values.DEMO_DURATION = input.duration;
	} else if (input.action !== "list")
		values.DEMO_FLEET = workflowFleet(input.action, input.fleet);
	if (input.action === "move")
		values.DEMO_DISCARD = input.discard ? "discard-old-queue" : "drain";
	if (input.action === "destroy") values.DEMO_CONFIRM = "delete";
	return values;
}

export function parseTaskReference(value: unknown) {
	const input = z
		.object({
			organizationId: z.string(),
			projectId: z.string(),
			taskId: z.number().int().positive(),
		})
		.strict()
		.parse(value);
	return { ...parseProjectReference(input), taskId: input.taskId };
}

export const taskStatuses = [
	"waiting",
	"starting",
	"waiting_confirmation",
	"confirmed",
	"rejected",
	"running",
	"stopping",
	"stopped",
	"success",
	"error",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export type TaskSummary = {
	id: number;
	action: WorkflowAction;
	status: TaskStatus;
	created: string | null;
	nativeUrl?: string;
};
