import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseProjectReference } from "../organizations/validation";
import * as analytics from "./analytics.server";
import * as saved from "./saved-insights.server";
import {
	parseDeleteInsights,
	parseSavedInsightReference,
	parseSaveInsight,
	parseUpdateInsightTags,
} from "./saved-insights-validation";
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

export const getOverviewSection = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseOverviewInput)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			analytics.overviewSection(database, actor, data, request.signal),
		),
	);

export const listSavedInsights = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => saved.listInsights(database, actor, data)),
	);

export const getSavedInsight = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseSavedInsightReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => saved.getInsight(database, actor, data)),
	);

export const saveInsight = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseSaveInsight)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => saved.saveInsight(database, actor, data)),
	);

export const deleteSavedInsights = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseDeleteInsights)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => saved.deleteInsights(database, actor, data)),
	);

export const updateInsightTags = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseUpdateInsightTags)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			saved.updateInsightTags(database, actor, data),
		),
	);

export const listInsightTags = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			saved.listInsightTags(database, actor, data),
		),
	);
