import { createServerFn } from "@tanstack/react-start";
import { withActor } from "../auth/actor.server";
import { privateOperation } from "../auth/private-operation";
import { parseProjectReference } from "../organizations/validation";
import * as activity from "./activity.server";
import { readColumns, saveColumns } from "./columns.server";
import {
	parseExplorer,
	parsePacket,
	parsePoint,
	parseSaveColumns,
} from "./validation";

export const listActivityPoints = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseExplorer)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			activity.listPoints(database, actor, data, request.signal),
		),
	);
export const getActivityPoint = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parsePoint)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			activity.pointDetail(database, actor, data, request.signal),
		),
	);
export const getActivityPacket = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parsePacket)
	.handler(({ data, context: { identity, database, request } }) =>
		withActor(identity, (actor) =>
			activity.packetDetail(database, actor, data, undefined, request.signal),
		),
	);
export const getExplorerColumns = createServerFn({ method: "GET" })
	.middleware([privateOperation])
	.validator(parseProjectReference)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => readColumns(database, actor, data)),
	);
export const saveExplorerColumns = createServerFn({ method: "POST" })
	.middleware([privateOperation])
	.validator(parseSaveColumns)
	.handler(({ data, context: { identity, database } }) =>
		withActor(identity, (actor) => saveColumns(database, actor, data)),
	);
