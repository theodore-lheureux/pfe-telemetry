import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseProjectReference } from "../organizations/validation";
import * as analytics from "./analytics.server";
import {
	parseMetricAttributesInput,
	parseOverviewInput,
	parseRunQueryInput,
} from "./validation";

export const runAnalyticsQuery = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseRunQueryInput)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			analytics.runAnalyticsQuery(database, actor, data, request.signal),
		),
	);

export const getAnalyticsCatalog = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			analytics.analyticsCatalog(database, actor, data, request.signal),
		),
	);

export const getMetricAttributes = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseMetricAttributesInput)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			analytics.metricAttributes(database, actor, data, request.signal),
		),
	);

export const getFleetOverview = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseOverviewInput)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			analytics.fleetOverview(database, actor, data, request.signal),
		),
	);
