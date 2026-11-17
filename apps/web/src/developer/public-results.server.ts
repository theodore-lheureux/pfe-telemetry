import { z } from "zod";
import {
	cpuProfiles,
	gpuProfiles,
	isLoadAction,
	labSchema,
	type WorkflowAction,
	workflowFleet,
} from "./contracts";
import { publicTaskProgress } from "./task-progress.server";

const maximumDecodedBytes = 65_536;
const maximumEncodedLength = Math.ceil(maximumDecodedBytes / 3) * 4;
const completedStates = [
	"running",
	"completed",
	"stopped",
	"expired",
	"failed",
	"interrupted",
] as const;
const name = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const counter = z
	.number()
	.int()
	.min(0)
	.max(10 ** 10);
const missingNode = z
	.object({ name, state: z.enum(["missing", "starting", "failed"]) })
	.strict();
const checkpoint = {
	name,
	state: z.enum(completedStates),
	elapsed_seconds: z.number().finite().min(0).max(330),
};
const cpuNode = z
	.object({ ...checkpoint, operations: counter, matches: counter })
	.strict()
	.refine((node) => node.matches <= node.operations);
const gpuNode = z
	.object({
		...checkpoint,
		completed_bursts: z.number().int().min(0).max(1000),
		last_field: z.union([
			z.literal(1007),
			z.literal(1004),
			z.literal(1005),
			z.null(),
		]),
		exit_code: z.number().int().min(-128).max(255).nullable(),
	})
	.strict();
const common = {
	job_id: z.string().regex(/^load-[a-f0-9]{32}$/),
	lab_id: labSchema,
	project_id: z.string().uuid(),
	duration_seconds: z.number().int().min(1).max(300),
	state: z.enum(["partial", "completed", "failed", "running", "stopped"]),
};
const cpuResult = z
	.object({
		...common,
		cloud: z.literal("aws-cpu"),
		profile: z.enum(cpuProfiles),
		nodes: z
			.array(z.union([cpuNode, missingNode]))
			.min(2)
			.max(200),
		reduction: z
			.object({
				operations: z
					.number()
					.int()
					.min(0)
					.max(2 * 10 ** 12),
				matches: z
					.number()
					.int()
					.min(0)
					.max(2 * 10 ** 12),
				checksum: z.string().regex(/^(?:0|[1-9][0-9]{0,82})$/),
				pi_estimate: z.number().finite().min(0).max(4).optional(),
			})
			.strict(),
	})
	.strict();
const gpuResult = z
	.object({
		...common,
		cloud: z.literal("gcp-gpu"),
		profile: z.enum(gpuProfiles),
		nodes: z.array(z.union([gpuNode, missingNode])).length(1),
	})
	.strict();
const loadResult = z.discriminatedUnion("cloud", [cpuResult, gpuResult]);
type LoadResult = z.infer<typeof loadResult>;
const createResult = z
	.object({ lab_id: labSchema, ttl: z.enum(["15m", "30m", "1h", "2h", "4h"]) })
	.strict();
export type PublicTaskResult =
	| { kind: "create"; result: z.infer<typeof createResult> }
	| { kind: "load"; result: LoadResult };
export type PublicResultScope = {
	action: WorkflowAction;
	projectId: string;
	survey: unknown;
};

function combinedState(nodes: LoadResult["nodes"]) {
	const states = new Set(nodes.map((node) => node.state));
	if (states.size === 1 && states.has("completed")) return "completed";
	if (states.has("failed")) return "failed";
	if (states.has("running") || states.has("starting")) return "running";
	if (states.size === 1 && states.has("stopped")) return "stopped";
	return "partial";
}

function consistentCpu(result: z.infer<typeof cpuResult>) {
	let operations = 0;
	let matches = 0;
	for (const node of result.nodes) {
		if ("operations" in node) {
			operations += node.operations;
			matches += node.matches;
		}
	}
	if (
		result.reduction.operations !== operations ||
		result.reduction.matches !== matches
	)
		return false;
	const checksum = BigInt(result.reduction.checksum);
	if (result.profile === "cpu-hash" && checksum >= 2n ** 64n) return false;
	if (checksum > BigInt(result.nodes.length) * (10n ** 80n - 1n)) return false;
	if (result.profile === "cpu-pi" && operations > 0)
		return result.reduction.pi_estimate === (4 * matches) / operations;
	return result.reduction.pi_estimate === undefined;
}

function consistentGpu(result: z.infer<typeof gpuResult>) {
	const fields = {
		"gpu-fp32": [1007],
		"gpu-tensor": [1004],
		"gpu-memory": [1005],
		"gpu-mixed": [1007, 1004, 1005],
	}[result.profile];
	return result.nodes.every(
		(node) =>
			!("last_field" in node) ||
			node.last_field === null ||
			fields.includes(node.last_field),
	);
}

function decodeLine(line: string) {
	if (Buffer.byteLength(line) > 2 * maximumEncodedLength) return null;
	// Strip only syntactically valid SGR colour sequences, not OSC, cursor moves,
	// backspaces, or partial escapes which could rewrite the apparent record.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour records require matching the literal escape delimiter.
	const plain = line.replace(/\x1b\[(?:[0-9]{1,3}(?:;[0-9]{1,3})*)?m/g, "");
	const match =
		/^[ \t]*"msg"[ \t]*:[ \t]*"RECOUNT_PUBLIC_(CREATE|LOAD) ([A-Za-z0-9+/]+={0,2})"[ \t\r]*$/.exec(
			plain,
		);
	if (!match) return null;
	const encoded = match[2];
	if (encoded.length > maximumEncodedLength || encoded.length % 4 !== 0)
		return null;
	const bytes = Buffer.from(encoded, "base64");
	if (
		bytes.length > maximumDecodedBytes ||
		bytes.toString("base64") !== encoded
	)
		return null;
	try {
		return {
			kind: match[1],
			value: JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			) as unknown,
		};
	} catch {
		return null;
	}
}

function parseCreate(value: unknown, survey: unknown): PublicTaskResult | null {
	const result = createResult.safeParse(value);
	const expected = z
		.object({
			DEMO_TTL: createResult.shape.ttl,
			DEMO_LAB: labSchema.optional(),
		})
		.safeParse(survey);
	if (
		!result.success ||
		!expected.success ||
		result.data.ttl !== expected.data.DEMO_TTL
	)
		return null;
	if (expected.data.DEMO_LAB) {
		if (result.data.lab_id !== expected.data.DEMO_LAB) return null;
	} else if (!/^demo-[a-f0-9]{16}$/.test(result.data.lab_id)) return null;
	return { kind: "create", result: result.data };
}

function parseLoad(
	value: unknown,
	scope: PublicResultScope,
): PublicTaskResult | null {
	const result = loadResult.safeParse(value);
	const expected = z
		.object({
			DEMO_LAB: labSchema,
			DEMO_FLEET: z.enum(["aws-cpu", "gcp-gpu"]).optional(),
			DEMO_WORKLOAD: z.enum([...cpuProfiles, ...gpuProfiles]).optional(),
			DEMO_DURATION: z
				.string()
				.regex(/^(?:[1-9]|[1-9][0-9]|[12][0-9]{2}|300)$/)
				.optional(),
		})
		.safeParse(scope.survey);
	if (!result.success || !expected.success) return null;
	const body = result.data;
	const starting = scope.action === "load-cpu" || scope.action === "load-gpu";
	if (starting === (expected.data.DEMO_FLEET !== undefined)) return null;
	if (
		body.project_id !== scope.projectId ||
		body.lab_id !== expected.data.DEMO_LAB ||
		body.cloud !== workflowFleet(scope.action, expected.data.DEMO_FLEET)
	)
		return null;
	if (starting) {
		if (
			body.profile !== expected.data.DEMO_WORKLOAD ||
			!expected.data.DEMO_DURATION ||
			body.duration_seconds > Number(expected.data.DEMO_DURATION)
		)
			return null;
	}
	if (
		new Set(body.nodes.map((node) => node.name)).size !== body.nodes.length ||
		combinedState(body.nodes) !== body.state
	)
		return null;
	if (body.cloud === "aws-cpu" && !consistentCpu(body)) return null;
	if (body.cloud === "gcp-gpu" && !consistentGpu(body)) return null;
	return { kind: "load", result: body };
}

export function parsePublicTaskLine(
	line: string,
	scope: PublicResultScope,
): PublicTaskResult | null {
	const decoded = decodeLine(line);
	if (!decoded) return null;
	if (
		(scope.action === "create-cpu" || scope.action === "create-gpu") &&
		decoded.kind === "CREATE"
	)
		return parseCreate(decoded.value, scope.survey);
	if (isLoadAction(scope.action) && decoded.kind === "LOAD")
		return parseLoad(decoded.value, scope);
	return null;
}

export function publicTaskOutput(lines: string[], scope: PublicResultScope) {
	let selected: PublicTaskResult | null = null;
	let conflicting = false;
	const progress = new Set<string>();
	for (const output of lines) {
		for (const line of output.split("\n")) {
			const step = publicTaskProgress(line);
			if (step) progress.add(step);
			const parsed = parsePublicTaskLine(line, scope);
			if (!parsed) continue;
			if (
				selected &&
				selected.kind === "create" &&
				parsed.kind === "create" &&
				selected.result.lab_id !== parsed.result.lab_id
			)
				conflicting = true;
			if (
				selected &&
				selected.kind === "load" &&
				parsed.kind === "load" &&
				selected.result.job_id !== parsed.result.job_id
			)
				conflicting = true;
			selected = parsed;
		}
	}
	const result =
		selected && !conflicting ? JSON.stringify(selected.result, null, 2) : "";
	return [[...progress].join("\n"), result].filter(Boolean).join("\n\n");
}
