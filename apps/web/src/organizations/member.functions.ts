import { createServerFn } from "@tanstack/react-start";
import {
	getRequestHeaders,
	setResponseHeader,
} from "@tanstack/react-start/server";
import { parseMemberReference, parseMemberRole } from "./member-contracts";
import { getOrganizationRequests } from "./request.server";
import {
	parseOrganizationReference,
	parseProjectReference,
} from "./validation";

function privateHeaders() {
	setResponseHeader("Cache-Control", "private, no-store");
	return getRequestHeaders();
}

export const listOrganizationMembers = createServerFn({ method: "GET" })
	.validator(parseOrganizationReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().listOrganizationMembers(
			privateHeaders(),
			data.organizationId,
		),
	);

export const listProjectGrantCandidates = createServerFn({ method: "GET" })
	.validator(parseProjectReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().listProjectGrantCandidates(
			privateHeaders(),
			data,
		),
	);

export const updateOrganizationMemberRole = createServerFn({ method: "POST" })
	.validator(parseMemberRole)
	.handler(async ({ data }) =>
		getOrganizationRequests().updateOrganizationMemberRole(
			privateHeaders(),
			data,
		),
	);

export const removeOrganizationMember = createServerFn({ method: "POST" })
	.validator(parseMemberReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().removeOrganizationMember(privateHeaders(), data),
	);

export const leaveOrganization = createServerFn({ method: "POST" })
	.validator(parseOrganizationReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().leaveOrganization(
			privateHeaders(),
			data.organizationId,
		),
	);
