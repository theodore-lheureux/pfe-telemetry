import { createMiddleware, createServerFn } from "@tanstack/react-start";
import {
	getRequest,
	getRequestHeaders,
	setResponseHeader,
} from "@tanstack/react-start/server";
import { parseProjectReference } from "../organizations/validation";
import { getExecutionRequests } from "./request.server";
import {
	parseCreateExecution,
	parseExecutionList,
	parseExecutionReference,
	parseTelemetryInput,
	parseUpdateExecution,
} from "./validation";

const privateResponse = createMiddleware({ type: "function" }).server(
	({ next }) => {
		setResponseHeader("Cache-Control", "private, no-store");
		return next();
	},
);
export const listExecutions = createServerFn({ method: "GET" })
	.middleware([privateResponse])
	.validator(parseExecutionList)
	.handler(({ data }) =>
		getExecutionRequests().listExecutions(getRequestHeaders(), data),
	);
export const listExecutionSources = createServerFn({ method: "GET" })
	.middleware([privateResponse])
	.validator(parseProjectReference)
	.handler(({ data }) =>
		getExecutionRequests().listExecutionSources(getRequestHeaders(), data),
	);
export const getExecution = createServerFn({ method: "GET" })
	.middleware([privateResponse])
	.validator(parseExecutionReference)
	.handler(({ data }) =>
		getExecutionRequests().getExecution(getRequestHeaders(), data),
	);
export const createExecution = createServerFn({ method: "POST" })
	.middleware([privateResponse])
	.validator(parseCreateExecution)
	.handler(({ data }) =>
		getExecutionRequests().createExecution(getRequestHeaders(), data),
	);
export const updateExecution = createServerFn({ method: "POST" })
	.middleware([privateResponse])
	.validator(parseUpdateExecution)
	.handler(({ data }) =>
		getExecutionRequests().updateExecution(getRequestHeaders(), data),
	);
export const queryExecutionTelemetry = createServerFn({ method: "GET" })
	.middleware([privateResponse])
	.validator(parseTelemetryInput)
	.handler(({ data }) =>
		getExecutionRequests().queryExecutionTelemetry(
			getRequestHeaders(),
			data,
			getRequest().signal,
		),
	);
