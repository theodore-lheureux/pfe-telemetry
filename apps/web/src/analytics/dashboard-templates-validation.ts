import { parseUuid } from "../lib/input";
import { InputError } from "../lib/input-error";
import { parseProjectReference } from "../organizations/validation";
import {
	builtInDashboardTemplates,
	type CreateTemplateDashboardInput,
} from "./dashboard-templates";

export function parseCreateTemplateDashboard(
	value: unknown,
): CreateTemplateDashboardInput {
	const reference = parseProjectReference(value);
	const input = value as Record<string, unknown>;
	if (
		typeof input.templateId !== "string" ||
		!builtInDashboardTemplates().some(
			(template) => template.id === input.templateId,
		)
	)
		throw new InputError("INVALID_QUERY", "Unknown dashboard template");
	return {
		...reference,
		dashboardId: parseUuid(input.dashboardId, "dashboard identifier"),
		templateId: input.templateId,
	};
}
