import { OperationError } from "../lib/operation-error";
import type { LiveEvent } from "./contracts";

/** Nodes one Live connection may filter by. */
export const MAX_LIVE_NODES = 20;
const NODE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The node IDs of a Live `nodes` parameter, separated by commas; empty for all nodes. */
export function parseLiveNodes(value: string | null): string[] {
	if (!value) return [];
	const nodes = [...new Set(value.split(","))];
	if (nodes.length > MAX_LIVE_NODES || nodes.some((id) => !NODE_ID.test(id)))
		throw new OperationError(
			"INVALID_INPUT",
			"Invalid Live node filter",
			"INVALID_QUERY",
		);
	return nodes;
}

/**
 * Whether a packet may concern the chosen nodes. A notification lists at most 64
 * nodes, so a packet whose list was truncated is kept when no listed node matches:
 * it may still include a chosen one.
 */
export function liveMatches(event: LiveEvent, nodes: ReadonlySet<string>) {
	if (!nodes.size || event.limited) return true;
	return event.summary.nodes.some((node) => nodes.has(node.id));
}
