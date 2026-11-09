import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseProjectReference } from "../organizations/validation";
import * as credentials from "./credentials.server";
import {
	parseCollectorCredentialReference,
	parseCreateCollectorCredentialInput,
} from "./validation";

export const listCollectorCredentials = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			credentials.listCollectorCredentials(database, actor, data),
		),
	);
export const createCollectorCredential = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseCreateCollectorCredentialInput)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			credentials.createCollectorCredential(database, actor, data),
		),
	);
export const rotateCollectorCredential = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseCollectorCredentialReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			credentials.rotateCollectorCredential(database, actor, data),
		),
	);
export const revokeCollectorCredential = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseCollectorCredentialReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			credentials.revokeCollectorCredential(database, actor, data),
		),
	);
