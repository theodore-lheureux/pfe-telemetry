import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import * as overlaps from "./overlaps.server";
import { parseExecutionReference } from "./validation";

export const getExecutionOverlaps = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseExecutionReference)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			overlaps.getExecutionOverlaps(database, actor, data, request.signal),
		),
	);
export const getExecutionLoad = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseExecutionReference)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			overlaps.getExecutionLoad(database, actor, data, request.signal),
		),
	);
