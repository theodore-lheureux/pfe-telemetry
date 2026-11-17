import { parseExecutionKey } from "../executions/validation";
import { parseName, parseUuid } from "../lib/input";
import { InputError } from "../lib/input-error";
import { parseProjectReference } from "../organizations/validation";
import {
	builtInDashboardTemplates,
	type CreateTemplateDashboardInput,
	type SaveDashboardTemplateInput,
	type TemplateValues,
	type TemplateVariable,
} from "./dashboard-templates";
import { parseSaveDashboard } from "./dashboards-validation";

export function parseCreateTemplateDashboard(
	value: unknown,
): CreateTemplateDashboardInput {
	const reference = parseProjectReference(value);
	const input = value as Record<string, unknown>;
	const builtIn = builtInDashboardTemplates().some(
		(template) => template.id === input.templateId,
	);
	const templateId = builtIn
		? String(input.templateId)
		: parseUuid(input.templateId, "template identifier");
	return {
		...reference,
		dashboardId: parseUuid(input.dashboardId, "dashboard identifier"),
		templateId,
		...(input.name === undefined ? {} : { name: parseName(input.name) }),
		...(input.description === undefined
			? {}
			: {
					description: parseSaveDashboard({
						...reference,
						dashboardId: input.dashboardId,
						name: input.name ?? "Template",
						description: input.description,
					}).description,
				}),
		values: parseTemplateValues(input.values),
	};
}

const VARIABLE_VALUE: Record<
	TemplateVariable["name"],
	(value: unknown) => string
> = {
	$node: (value) => parseUuid(value, "node identifier"),
	$execution: (value) => {
		try {
			return parseExecutionKey(value);
		} catch {
			throw new InputError("INVALID_QUERY", "Invalid execution key");
		}
	},
};

function parseTemplateValues(value: unknown): TemplateValues {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new InputError("INVALID_QUERY", "Invalid template variables");
	const values: TemplateValues = {};
	for (const [name, entry] of Object.entries(value)) {
		if (!Object.hasOwn(VARIABLE_VALUE, name))
			throw new InputError("INVALID_QUERY", "Unknown template variable");
		const variable = name as TemplateVariable["name"];
		if (entry !== undefined)
			values[variable] =
				entry === null ? null : VARIABLE_VALUE[variable](entry);
	}
	return values;
}

export function parseSaveDashboardTemplate(
	value: unknown,
): SaveDashboardTemplateInput {
	const input = value as Record<string, unknown>;
	const dashboard = parseSaveDashboard(value);
	if (typeof input.parameterizeNode !== "boolean")
		throw new InputError("INVALID_QUERY", "Invalid template variables");
	return {
		...dashboard,
		templateId: parseUuid(input.templateId, "template identifier"),
		description: dashboard.description ?? "",
		parameterizeNode: input.parameterizeNode,
	};
}
