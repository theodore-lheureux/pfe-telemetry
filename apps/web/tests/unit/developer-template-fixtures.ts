import type { WorkflowAction } from "../../src/developer/contracts";

export function nativeSurvey(action: WorkflowAction) {
	const variable = (
		name: string,
		type = "",
		values?: string[],
		required = true,
	) => ({
		name,
		type,
		target: "env",
		...(required ? { required } : {}),
		...(values
			? { values: values.map((value) => ({ name: value, value })) }
			: {}),
	});
	if (action === "list") return [];
	const lab = variable("DEMO_LAB", "", undefined, !action.startsWith("create"));
	if (action.startsWith("create"))
		return [
			lab,
			variable("DEMO_COUNT", "int"),
			variable("DEMO_TTL", "enum", ["15m", "30m", "1h", "2h", "4h"]),
			variable("DEMO_COST", "enum", [
				action === "create-cpu" ? "on-demand" : "spot-only",
			]),
			variable("DEMO_PRESET", "enum", [
				action === "create-cpu" ? "t4g-nano" : "gpu-l4",
			]),
		];
	if (action === "load-cpu" || action === "load-gpu")
		return [
			lab,
			variable(
				"DEMO_WORKLOAD",
				"enum",
				action === "load-cpu"
					? ["cpu-hash", "cpu-primes", "cpu-pi"]
					: ["gpu-fp32", "gpu-tensor", "gpu-memory", "gpu-mixed"],
			),
			variable("DEMO_DURATION", "enum", ["60", "120", "180", "300"]),
		];
	const fields = [lab, variable("DEMO_FLEET", "enum", ["aws-cpu", "gcp-gpu"])];
	if (action === "move")
		fields.push(
			variable("DEMO_DISCARD", "enum", ["drain", "discard-old-queue"]),
		);
	if (action === "destroy")
		fields.push(variable("DEMO_CONFIRM", "enum", ["delete"]));
	return fields;
}
