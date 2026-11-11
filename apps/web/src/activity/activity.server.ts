import type { getDatabase } from "../db/client.server";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import type { ExplorerInput, PacketInput, PointInput } from "./contracts";
import { livePacket } from "./live.server";
import { readPoint, readPoints } from "./points.server";

type Database = ReturnType<typeof getDatabase>;

export async function listPoints(
	database: Database,
	actor: Actor,
	input: ExplorerInput,
	signal?: AbortSignal,
	read = readPoints,
) {
	await requireProject(database, actor, input);
	return read(input, signal);
}
export async function pointDetail(
	database: Database,
	actor: Actor,
	input: PointInput,
	signal?: AbortSignal,
	read = readPoint,
) {
	await requireProject(database, actor, input);
	return read(input, signal);
}
export async function authorizeLive(
	database: Database,
	actor: Actor,
	input: ProjectReference,
) {
	await requireProject(database, actor, input);
}
export async function packetDetail(
	database: Database,
	actor: Actor,
	input: PacketInput,
	read = livePacket,
	signal?: AbortSignal,
) {
	await requireProject(database, actor, input);
	return read(input, signal);
}
