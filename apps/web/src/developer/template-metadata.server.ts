import { z } from "zod";
import { cpuProfiles, gpuProfiles, type WorkflowAction } from "./contracts";

const field = z.object({
	name: z.string(),
	target: z.literal("env"),
	type: z.enum(["", "int", "enum"]).default(""),
	required: z.boolean().default(false),
	default_value: z.unknown().optional(),
	values: z.array(z.object({ value: z.string() })).default([]),
});
type Specification = {
	type: "" | "int" | "enum";
	values?: readonly string[];
	optional?: boolean;
};
export const surveyNames = [
	"DEMO_LAB",
	"DEMO_FLEET",
	"DEMO_COUNT",
	"DEMO_TTL",
	"DEMO_COST",
	"DEMO_PRESET",
	"DEMO_WORKLOAD",
	"DEMO_DURATION",
	"DEMO_DISCARD",
	"DEMO_CONFIRM",
];
function specifications(action: WorkflowAction): Record<string, Specification> {
	if (action === "list") return {};
	const result: Record<string, Specification> = {
		DEMO_LAB: { type: "", optional: action.startsWith("create") },
	};
	if (action.startsWith("create")) {
		return {
			...result,
			DEMO_COUNT: { type: "int" },
			DEMO_TTL: { type: "enum", values: ["15m", "30m", "1h", "2h", "4h"] },
			DEMO_COST: {
				type: "enum",
				values: [action === "create-cpu" ? "on-demand" : "spot-only"],
			},
			DEMO_PRESET: {
				type: "enum",
				values: [action === "create-cpu" ? "t4g-nano" : "gpu-l4"],
			},
		};
	}
	if (action === "load-cpu" || action === "load-gpu") {
		return {
			...result,
			DEMO_WORKLOAD: {
				type: "enum",
				values: action === "load-cpu" ? cpuProfiles : gpuProfiles,
			},
			DEMO_DURATION: { type: "enum", values: ["60", "120", "180", "300"] },
		};
	}
	result.DEMO_FLEET = { type: "enum", values: ["aws-cpu", "gcp-gpu"] };
	if (action === "move")
		result.DEMO_DISCARD = {
			type: "enum",
			values: ["drain", "discard-old-queue"],
		};
	if (action === "destroy")
		result.DEMO_CONFIRM = { type: "enum", values: ["delete"] };
	return result;
}

export function validActionMetadata(action: WorkflowAction, value: unknown) {
	const parsed = z.array(field).safeParse(value === undefined ? [] : value);
	if (!parsed.success) return false;
	const expected = specifications(action);
	if (
		parsed.data.length !== Object.keys(expected).length ||
		new Set(parsed.data.map((item) => item.name)).size !== parsed.data.length
	)
		return false;
	return parsed.data.every((item) => {
		if (!Object.hasOwn(expected, item.name)) return false;
		const spec = expected[item.name];
		if (item.type !== spec.type || item.required !== !spec.optional)
			return false;
		if (
			item.name === "DEMO_LAB" &&
			spec.optional &&
			item.default_value !== undefined &&
			item.default_value !== null &&
			item.default_value !== ""
		)
			return false;
		if (!spec.values) return item.values.length === 0;
		const values = item.values.map((entry) => entry.value);
		return (
			new Set(values).size === values.length &&
			values.length === spec.values.length &&
			spec.values.every((entry) => values.includes(entry))
		);
	});
}
