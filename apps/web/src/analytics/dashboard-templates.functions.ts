import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { createTemplateDashboard } from "./dashboard-templates.server";
import { parseCreateTemplateDashboard } from "./dashboard-templates-validation";

export const createDashboardFromTemplate = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseCreateTemplateDashboard)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			createTemplateDashboard(database, actor, data),
		),
	);
