import { useDebouncer } from "@tanstack/react-pacer";
import { useEffect, useRef, useState } from "react";

/**
 * The search field's text, applied to the URL once typing pauses. A pending search is
 * cancelled when the URL query changes elsewhere, such as back navigation, or on reset.
 */
export function useSearchText(
	q: string | undefined,
	apply: (q: string | undefined) => void,
) {
	const [text, setText] = useState(q ?? "");
	// The query this field last applied, to tell its own URL changes from others.
	const applied = useRef(q);
	const debouncer = useDebouncer(
		(value: string) => {
			const next = value.trim().slice(0, 128) || undefined;
			applied.current = next;
			apply(next);
		},
		{ wait: 300 },
	);
	useEffect(() => {
		if (q === applied.current) return;
		debouncer.cancel();
		applied.current = q;
		setText(q ?? "");
	}, [q, debouncer]);
	return {
		text,
		change(value: string) {
			setText(value);
			debouncer.maybeExecute(value);
		},
		reset() {
			debouncer.cancel();
			applied.current = undefined;
			setText("");
		},
	};
}
