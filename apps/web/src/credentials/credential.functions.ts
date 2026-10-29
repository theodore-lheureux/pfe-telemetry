import { createMiddleware, createServerFn } from "@tanstack/react-start";
import {
	getRequestHeaders,
	setResponseHeader,
} from "@tanstack/react-start/server";
import { parseProjectReference } from "../organizations/validation";
import { getCollectorCredentialRequests } from "./request.server";
import {
	parseCollectorCredentialReference,
	parseCreateCollectorCredentialInput,
} from "./validation";

const privateResponse = createMiddleware({ type: "function" }).server(
	({ next }) => {
		setResponseHeader("Cache-Control", "private, no-store");
		return next();
	},
);

export const listCollectorCredentials = createServerFn({ method: "GET" })
	.middleware([privateResponse])
	.validator(parseProjectReference)
	.handler(async ({ data }) =>
		getCollectorCredentialRequests().listCollectorCredentials(
			getRequestHeaders(),
			data,
		),
	);

export const createCollectorCredential = createServerFn({ method: "POST" })
	.middleware([privateResponse])
	.validator(parseCreateCollectorCredentialInput)
	.handler(async ({ data }) =>
		getCollectorCredentialRequests().createCollectorCredential(
			getRequestHeaders(),
			data,
		),
	);

export const rotateCollectorCredential = createServerFn({ method: "POST" })
	.middleware([privateResponse])
	.validator(parseCollectorCredentialReference)
	.handler(async ({ data }) =>
		getCollectorCredentialRequests().rotateCollectorCredential(
			getRequestHeaders(),
			data,
		),
	);

export const revokeCollectorCredential = createServerFn({ method: "POST" })
	.middleware([privateResponse])
	.validator(parseCollectorCredentialReference)
	.handler(async ({ data }) =>
		getCollectorCredentialRequests().revokeCollectorCredential(
			getRequestHeaders(),
			data,
		),
	);
