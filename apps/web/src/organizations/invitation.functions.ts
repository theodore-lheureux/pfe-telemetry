import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import {
	parseCreateInvitationInput,
	parseCreateInvitationsInput,
	parseInvitationReference,
	parseOrganizationInvitationReference,
} from "./invitation-validation";
import * as invitations from "./invitations.server";
import { parseOrganizationReference } from "./validation";

export const createInvitations = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseCreateInvitationsInput)
	.handler(
		({ data, context: { identity, database, auth, headers, request } }) =>
			withActor(identity, (actor) =>
				invitations.createInvitations(
					database,
					auth,
					headers,
					actor,
					data,
					request,
				),
			),
	);
export const resendInvitation = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseCreateInvitationInput)
	.handler(({ data, context: { identity, auth, headers, request } }) =>
		withActor(identity, () =>
			invitations.createInvitation(
				auth,
				headers,
				{ ...data, resend: true },
				request,
			),
		),
	);
export const listInvitations = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseOrganizationReference)
	.handler(({ data, context: { identity, auth, headers } }) =>
		withActor(identity, () =>
			invitations.listInvitations(auth, headers, data.organizationId),
		),
	);
export const cancelInvitation = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseOrganizationInvitationReference)
	.handler(({ data, context: { identity, database, auth, headers } }) =>
		withActor(identity, (actor) =>
			invitations.cancelInvitation(database, auth, headers, actor, data),
		),
	);
export const inspectInvitation = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseInvitationReference)
	.handler(({ data, context: { identity, auth, headers } }) =>
		withActor(identity, () =>
			invitations.inspectInvitation(auth, headers, data),
		),
	);
export const acceptInvitation = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseInvitationReference)
	.handler(({ data, context: { identity, auth, headers } }) =>
		withActor(identity, () =>
			invitations.acceptInvitation(auth, headers, data),
		),
	);
export const rejectInvitation = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseInvitationReference)
	.handler(({ data, context: { identity, auth, headers } }) =>
		withActor(identity, () =>
			invitations.rejectInvitation(auth, headers, data),
		),
	);
