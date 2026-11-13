import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseProjectReference } from "../organizations/validation";
import * as dashboards from "./dashboards.server";
import {
	parseAddTiles,
	parseDashboardReference,
	parseLayout,
	parseRemoveTile,
	parseSaveDashboard,
} from "./dashboards-validation";

export const listDashboards = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			dashboards.listDashboards(database, actor, data),
		),
	);

export const getDashboard = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseDashboardReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			dashboards.getDashboard(database, actor, data),
		),
	);

export const saveDashboard = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseSaveDashboard)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			dashboards.saveDashboard(database, actor, data),
		),
	);

export const deleteDashboard = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseDashboardReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			dashboards.deleteDashboard(database, actor, data),
		),
	);

export const addDashboardTiles = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseAddTiles)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => dashboards.addTiles(database, actor, data)),
	);

export const updateDashboardLayout = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseLayout)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			dashboards.updateLayout(database, actor, data),
		),
	);

export const removeDashboardTile = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseRemoveTile)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			dashboards.removeTile(database, actor, data),
		),
	);
