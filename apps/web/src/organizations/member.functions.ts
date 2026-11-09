import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseMemberReference, parseMemberRole } from "./member-contracts";
import * as members from "./members.server";
import {
	parseOrganizationReference,
	parseProjectReference,
} from "./validation";

export const listOrganizationMembers = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseOrganizationReference)
	.handler(({ data, context: { identity, database, auth, headers } }) =>
		withActor(identity, (actor) =>
			members.listOrganizationMembers(
				database,
				auth,
				headers,
				actor,
				data.organizationId,
			),
		),
	);
export const listProjectGrantCandidates = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database, auth, headers } }) =>
		withActor(identity, (actor) =>
			members.listProjectGrantCandidates(database, auth, headers, actor, data),
		),
	);
export const updateOrganizationMemberRole = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseMemberRole)
	.handler(({ data, context: { identity, database, auth, headers } }) =>
		withActor(identity, (actor) =>
			members.updateRole(database, auth, headers, actor, data),
		),
	);
export const removeOrganizationMember = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseMemberReference)
	.handler(({ data, context: { identity, database, auth, headers } }) =>
		withActor(identity, (actor) =>
			members.removeMember(database, auth, headers, actor, data),
		),
	);
export const leaveOrganization = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseOrganizationReference)
	.handler(({ data, context: { identity, database, auth, headers } }) =>
		withActor(identity, (actor) =>
			members.leaveOrganization(
				database,
				auth,
				headers,
				actor,
				data.organizationId,
			),
		),
	);
