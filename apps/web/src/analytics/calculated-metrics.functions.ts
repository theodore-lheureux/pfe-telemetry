import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseMetricReference } from "../definitions/validation";
import {
	deleteCalculation,
	getCalculation,
	parseDeleteCalculation,
	parseSaveCalculation,
	saveCalculation,
} from "./calculated-metrics.server";

export const saveCalculatedMetric = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseSaveCalculation)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			saveCalculation(database, actor, data, request.signal),
		),
	);
export const getCalculatedMetric = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseMetricReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => getCalculation(database, actor, data)),
	);
export const deleteCalculatedMetric = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseDeleteCalculation)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => deleteCalculation(database, actor, data)),
	);
