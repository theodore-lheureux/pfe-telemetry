import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseProjectReference } from "../organizations/validation";
import * as definitions from "./definitions.server";
import {
	parseAttributeReference,
	parseMetricReference,
	parseUpdateAttribute,
	parseUpdateMetric,
} from "./validation";

export const listMetricDefinitions = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			definitions.listMetricEntries(database, actor, data, request.signal),
		),
	);

export const listAttributeDefinitions = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			definitions.listAttributeEntries(database, actor, data, request.signal),
		),
	);

export const listMetricAttributeDefinitions = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseMetricReference)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			definitions.listMetricAttributeEntries(
				database,
				actor,
				data,
				request.signal,
			),
		),
	);

export const getMetricDefinition = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseMetricReference)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			definitions.getMetricDetail(database, actor, data, request.signal),
		),
	);

export const getAttributeDefinition = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseAttributeReference)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			definitions.getAttributeDetail(database, actor, data, request.signal),
		),
	);

export const updateMetricDefinition = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseUpdateMetric)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			definitions.updateMetric(database, actor, data),
		),
	);

export const updateAttributeDefinition = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseUpdateAttribute)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			definitions.updateAttribute(database, actor, data),
		),
	);
