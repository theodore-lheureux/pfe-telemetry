import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseProjectReference } from "../organizations/validation";
import * as collectors from "./collectors.server";
import {
	parseCreateEnrollmentKeyInput,
	parseEnrollmentKeyReference,
	parseListNodesInput,
	parseNodesReference,
} from "./validation";

export const listEnrollmentKeys = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			collectors.listEnrollmentKeys(database, actor, data),
		),
	);
export const createEnrollmentKey = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseCreateEnrollmentKeyInput)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			collectors.createEnrollmentKey(database, actor, data),
		),
	);
export const revokeEnrollmentKey = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseEnrollmentKeyReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			collectors.revokeEnrollmentKey(database, actor, data),
		),
	);
export const listNodes = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseListNodesInput)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => collectors.listNodes(database, actor, data)),
	);
export const revokeNodes = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseNodesReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			collectors.revokeNodes(database, actor, data),
		),
	);
export const deleteNodes = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseNodesReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			collectors.deleteNodes(database, actor, data),
		),
	);
