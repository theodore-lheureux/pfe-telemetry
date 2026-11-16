import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseProjectReference } from "../organizations/validation";
import {
	createTemplateDashboard,
	listDashboardTemplates as list,
	saveDashboardTemplate as save,
} from "./dashboard-templates.server";
import {
	parseCreateTemplateDashboard,
	parseSaveDashboardTemplate,
} from "./dashboard-templates-validation";

export const listDashboardTemplates = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => list(database, actor, data)),
	);

export const saveDashboardTemplate = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseSaveDashboardTemplate)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => save(database, actor, data)),
	);

export const createDashboardFromTemplate = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseCreateTemplateDashboard)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			createTemplateDashboard(database, actor, data),
		),
	);
