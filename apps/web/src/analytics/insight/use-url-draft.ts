import { useHotkey } from "@tanstack/react-hotkeys";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { decodeDraft, encodeDraft, type InsightDraft } from "./draft";

// Edits closer together than this share one history entry, so typing a formula or
// dragging a zoom is one step back rather than one per keystroke.
const STEP_GAP_MS = 1000;

/**
 * The draft kept in the `q` search parameter. Settled edits add browser history
 * entries; Back, Forward, ⌘Z and ⇧⌘Z (Ctrl+Z, Ctrl+Y) move between them.
 */
export function useUrlDraft(
	/** The `q` parameter the page opened with. */
	q: string | undefined,
	write: (q: string, replace: boolean) => void,
) {
	const router = useRouter();
	const [draft, setDraft] = useState(() => decodeDraft(q));
	const lastEdit = useRef(0);
	// The browser history, not router state: the router updates only after a navigation's
	// data loads, so its location can lag an edit made a moment ago.
	const position = () => router.history.location.state.__TSR_index ?? 0;
	// History entries this editor created: from the one it opened on to the newest.
	const first = useRef(position());
	const last = useRef(position());

	// Back and Forward change the URL without an edit; the draft follows the entry.
	useEffect(() => {
		const page = router.history.location.pathname;
		return router.history.subscribe(({ location, action }) => {
			if (action.type === "PUSH" || action.type === "REPLACE") return;
			if (location.pathname !== page) return;
			const next = router.options.parseSearch(location.search).q;
			setDraft(decodeDraft(typeof next === "string" ? next : undefined));
		});
	}, [router]);

	const change = (next: InsightDraft) => {
		setDraft(next);
		const text = encodeDraft(next);
		const now = Date.now();
		const step = now - lastEdit.current > STEP_GAP_MS;
		lastEdit.current = now;
		// A new step discards the steps that were ahead of it.
		if (step) last.current = position() + 1;
		write(text, !step);
	};

	// Only steps this editor made: undo never leaves the page, redo never re-enters it.
	const undo = () => {
		if (position() > first.current) router.history.back();
	};
	const redo = () => {
		if (position() < last.current) router.history.forward();
	};
	// Text fields keep their own undo.
	const keys = { ignoreInputs: true } as const;
	useHotkey("Mod+Z", undo, keys);
	useHotkey("Mod+Shift+Z", redo, keys);
	useHotkey("Mod+Y", redo, keys);

	return [draft, change] as const;
}
