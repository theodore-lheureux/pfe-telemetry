import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import * as organizations from "./organizations.server";
import * as projects from "./projects.server";
import {
	parseCreateProjectInput,
	parseOrganizationInput,
	parseOrganizationReference,
	parseProjectMembershipInput,
	parseProjectMembershipReference,
	parseProjectReference,
	parseUpdateOrganizationInput,
	parseUpdateProjectInput,
} from "./validation";

export const listOrganizations = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.handler(({ context: { identity, database } }) =>
		withActor(identity, (actor) =>
			organizations.listOrganizations(database, actor),
		),
	);
export const getOrganization = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseOrganizationReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			organizations.getOrganization(database, actor, data.organizationId),
		),
	);
export const createOrganization = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseOrganizationInput)
	.handler(({ data, context: { identity, auth, headers } }) =>
		withActor(identity, () =>
			organizations.createOrganization(auth, headers, data),
		),
	);
export const updateOrganization = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseUpdateOrganizationInput)
	.handler(({ data, context: { identity, database, auth, headers } }) =>
		withActor(identity, (actor) =>
			organizations.updateOrganization(database, auth, headers, actor, data),
		),
	);
export const listProjects = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseOrganizationReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			projects.listProjects(database, actor, data.organizationId),
		),
	);
export const getProject = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => projects.getProject(database, actor, data)),
	);
export const createProject = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseCreateProjectInput)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			projects.createProject(database, actor, data),
		),
	);
export const updateProject = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseUpdateProjectInput)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			projects.updateProject(database, actor, data),
		),
	);
export const listProjectMembers = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			projects.listProjectMembers(database, actor, data),
		),
	);
export const setProjectMember = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseProjectMembershipInput)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			projects.setProjectMember(database, actor, data),
		),
	);
export const removeProjectMember = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseProjectMembershipReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			projects.removeProjectMember(database, actor, data),
		),
	);
