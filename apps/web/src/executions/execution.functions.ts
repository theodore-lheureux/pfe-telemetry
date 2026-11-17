import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import * as executions from "./executions.server";
import {
	parseExecutionList,
	parseExecutionMeasurements,
	parseExecutionReference,
} from "./validation";

export const listExecutions = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseExecutionList)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			executions.listExecutions(database, actor, data, request.signal),
		),
	);
export const getExecution = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseExecutionReference)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			executions.getExecution(database, actor, data, request.signal),
		),
	);
export const getExecutionMeasurements = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseExecutionMeasurements)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			executions.getExecutionMeasurements(
				database,
				actor,
				data,
				request.signal,
			),
		),
	);
