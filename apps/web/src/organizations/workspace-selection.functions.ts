import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseIdentifier } from "../lib/input";
import {
	readWorkspacePreference,
	workspaceCookieName,
} from "./workspace-preference";
import { resolveWorkspace } from "./workspace-selection.server";

export const getWorkspaceSelection = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator((input: { organizationId?: string; projectId?: string }) => ({
		organizationId:
			input.organizationId === undefined
				? undefined
				: parseIdentifier(input.organizationId),
		projectId:
			input.projectId === undefined
				? undefined
				: parseIdentifier(input.projectId),
	}))
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			resolveWorkspace(
				database,
				actor,
				data,
				readWorkspacePreference(getCookie(workspaceCookieName(actor.id))),
			),
		),
	);
