import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseProjectReference } from "../organizations/validation";
import * as executions from "./executions.server";
import {
	parseCreateExecution,
	parseExecutionList,
	parseExecutionReference,
	parseTelemetryInput,
	parseUpdateExecution,
} from "./validation";

export const listExecutions = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseExecutionList)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			executions.listExecutions(database, actor, data),
		),
	);
export const listExecutionSources = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			executions.listExecutionSources(database, actor, data),
		),
	);
export const getExecution = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseExecutionReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			executions.getExecution(database, actor, data),
		),
	);
export const createExecution = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseCreateExecution)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			executions.createExecution(database, actor, data),
		),
	);
export const updateExecution = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseUpdateExecution)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			executions.updateExecution(database, actor, data),
		),
	);
export const queryExecutionTelemetry = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseTelemetryInput)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			executions.queryExecutionTelemetry(database, actor, data, request.signal),
		),
	);
