import { createServerFn } from "@tanstack/react-start";
import {
	getRequest,
	getRequestHeaders,
	setResponseHeader,
} from "@tanstack/react-start/server";
import {
	parseCreateInvitationInput,
	parseInvitationReference,
	parseOrganizationInvitationReference,
} from "./invitation-validation";
import { getOrganizationRequests } from "./request.server";
import { parseOrganizationReference } from "./validation";

function privateHeaders() {
	setResponseHeader("Cache-Control", "private, no-store");
	return getRequestHeaders();
}

export const createInvitation = createServerFn({ method: "POST" })
	.validator(parseCreateInvitationInput)
	.handler(async ({ data }) =>
		getOrganizationRequests().createInvitation(
			privateHeaders(),
			data,
			getRequest(),
		),
	);

export const listInvitations = createServerFn({ method: "GET" })
	.validator(parseOrganizationReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().listInvitations(
			privateHeaders(),
			data.organizationId,
		),
	);

export const cancelInvitation = createServerFn({ method: "POST" })
	.validator(parseOrganizationInvitationReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().cancelInvitation(privateHeaders(), data),
	);

export const inspectInvitation = createServerFn({ method: "GET" })
	.validator(parseInvitationReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().inspectInvitation(privateHeaders(), data),
	);

export const acceptInvitation = createServerFn({ method: "POST" })
	.validator(parseInvitationReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().acceptInvitation(privateHeaders(), data),
	);

export const rejectInvitation = createServerFn({ method: "POST" })
	.validator(parseInvitationReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().rejectInvitation(privateHeaders(), data),
	);
