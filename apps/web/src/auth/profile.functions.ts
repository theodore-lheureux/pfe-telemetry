import { createServerFn } from "@tanstack/react-start";
import { parseIdentifier, parseName } from "../lib/input";
import { withActor } from "./actor.server";
import { privateOperation } from "./private-operation";
import * as profile from "./profile.server";

export const updateProfileName = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator((value: { name: string; userId: string }) => ({
		name: parseName(value.name),
		userId: parseIdentifier(value.userId),
	}))
	.handler(({ data, context: { identity, auth, headers } }) =>
		withActor(identity, () =>
			profile.updateProfileName(auth, headers, data.name, data.userId),
		),
	);

export const listWebSessions = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.handler(({ context: { identity, database, auth, headers } }) =>
		withActor(identity, () => profile.listWebSessions(database, auth, headers)),
	);

export const revokeWebSession = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator((value: { id: string }) => ({ id: parseIdentifier(value.id) }))
	.handler(({ data, context: { identity, auth, headers } }) =>
		withActor(identity, () => profile.revokeWebSession(auth, headers, data.id)),
	);
