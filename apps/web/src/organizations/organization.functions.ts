import { createServerFn } from "@tanstack/react-start";
import {
	getRequestHeaders,
	setResponseHeader,
} from "@tanstack/react-start/server";
import { getOrganizationRequests } from "./request.server";
import {
	parseCreateProjectInput,
	parseOrganizationInput,
	parseOrganizationReference,
	parseProjectMembershipInput,
	parseProjectMembershipReference,
	parseProjectReference,
	parseUpdateProjectInput,
} from "./validation";

function privateHeaders() {
	setResponseHeader("Cache-Control", "private, no-store");
	return getRequestHeaders();
}

export const listOrganizations = createServerFn({ method: "GET" }).handler(
	async () => getOrganizationRequests().listOrganizations(privateHeaders()),
);

export const getOrganization = createServerFn({ method: "GET" })
	.validator(parseOrganizationReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().getOrganization(
			privateHeaders(),
			data.organizationId,
		),
	);

export const createOrganization = createServerFn({ method: "POST" })
	.validator(parseOrganizationInput)
	.handler(async ({ data }) =>
		getOrganizationRequests().createOrganization(privateHeaders(), data),
	);

export const listProjects = createServerFn({ method: "GET" })
	.validator(parseOrganizationReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().listProjects(
			privateHeaders(),
			data.organizationId,
		),
	);

export const getProject = createServerFn({ method: "GET" })
	.validator(parseProjectReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().getProject(privateHeaders(), data),
	);

export const createProject = createServerFn({ method: "POST" })
	.validator(parseCreateProjectInput)
	.handler(async ({ data }) =>
		getOrganizationRequests().createProject(privateHeaders(), data),
	);

export const updateProject = createServerFn({ method: "POST" })
	.validator(parseUpdateProjectInput)
	.handler(async ({ data }) =>
		getOrganizationRequests().updateProject(privateHeaders(), data),
	);

export const listProjectMembers = createServerFn({ method: "GET" })
	.validator(parseProjectReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().listProjectMembers(privateHeaders(), data),
	);

export const setProjectMember = createServerFn({ method: "POST" })
	.validator(parseProjectMembershipInput)
	.handler(async ({ data }) =>
		getOrganizationRequests().setProjectMember(privateHeaders(), data),
	);

export const removeProjectMember = createServerFn({ method: "POST" })
	.validator(parseProjectMembershipReference)
	.handler(async ({ data }) =>
		getOrganizationRequests().removeProjectMember(privateHeaders(), data),
	);
