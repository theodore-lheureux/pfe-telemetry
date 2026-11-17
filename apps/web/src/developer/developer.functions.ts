import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseProjectReference } from "../organizations/validation";
import { parseTaskReference, parseWorkflow } from "./contracts";
import { developerOperations } from "./developer.server";

export const developerCapability = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			developerOperations().capability(database, actor, data),
		),
	);
export const developerTasks = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			developerOperations().recent(database, actor, data),
		),
	);
export const developerOutput = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseTaskReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			developerOperations().output(database, actor, data),
		),
	);
export const runDeveloperWorkflow = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseWorkflow)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) =>
			developerOperations().run(database, actor, data),
		),
	);
