import { useHotkey } from "@tanstack/react-hotkeys";
import { useRef } from "react";
import type { DashboardTile } from "../dashboards";

/** Layout steps kept to undo; older ones are dropped. */
const MAX_STEPS = 50;

function sameTiles(a: DashboardTile[], b: DashboardTile[]) {
	const ids = new Set(a.map((tile) => tile.id));
	return a.length === b.length && b.every((tile) => ids.has(tile.id));
}

/**
 * Undo and redo of moves and resizes with ⌘Z and ⇧⌘Z (Ctrl+Z, Ctrl+Y), for this visit.
 * Each step is saved like any other layout change. A step is dropped once tiles have
 * been added or removed, since the server accepts only layouts of the current tiles.
 */
export function useLayoutHistory({
	tiles,
	canEdit,
	busy,
	apply,
}: {
	tiles: DashboardTile[];
	canEdit: boolean;
	/** While a change saves, presses do nothing. */
	busy: boolean;
	apply: (tiles: DashboardTile[]) => void;
}) {
	const past = useRef<DashboardTile[][]>([]);
	const future = useRef<DashboardTile[][]>([]);
	const step = (from: typeof past, to: typeof past) => {
		if (busy) return;
		const target = from.current.pop();
		if (!target) return;
		if (!sameTiles(target, tiles)) {
			past.current = [];
			future.current = [];
			return;
		}
		to.current.push(tiles);
		apply(target);
	};
	// Text fields keep their own undo. The keys stay claimed while a change saves, so a
	// press then does nothing rather than reaching the browser, whose own ⌘Z can reopen
	// a closed tab.
	const keys = { ignoreInputs: true, enabled: canEdit } as const;
	useHotkey("Mod+Z", () => step(past, future), keys);
	useHotkey("Mod+Shift+Z", () => step(future, past), keys);
	useHotkey("Mod+Y", () => step(future, past), keys);
	return {
		/** Call with the layout before a move or resize. */
		record(previous: DashboardTile[]) {
			past.current = [...past.current, previous].slice(-MAX_STEPS);
			future.current = [];
		},
	};
}
