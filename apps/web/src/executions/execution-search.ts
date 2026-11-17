import { parseNodeId } from "./validation";

/** The machine and instant an execution page shows measurements for. */
export interface ExecutionSearch {
	node?: string;
	/** An ISO timestamp. */
	at?: string;
}

/** Drops unreadable values, so a stale or edited link still opens the page. */
export function parseExecutionSearch(
	search: Record<string, unknown>,
): ExecutionSearch {
	let node: string | undefined;
	try {
		node = parseNodeId(search.node);
	} catch {
		node = undefined;
	}
	const at =
		typeof search.at === "string" && Number.isFinite(Date.parse(search.at))
			? new Date(search.at).toISOString()
			: undefined;
	return { ...(node ? { node } : {}), ...(at ? { at } : {}) };
}

/** A change to the selection: null clears a value, absent keeps it. */
export interface SelectionPatch {
	node?: string | null;
	at?: number | null;
}

export function applySelection(
	search: ExecutionSearch,
	patch: SelectionPatch,
): ExecutionSearch {
	const node = patch.node === undefined ? search.node : patch.node;
	const at =
		patch.at === undefined
			? search.at
			: patch.at && new Date(patch.at).toISOString();
	return { ...(node ? { node } : {}), ...(at ? { at } : {}) };
}
