import { type RefObject, useEffect, useState } from "react";

/** The nearest ancestor that scrolls vertically, or null when the page itself scrolls. */
function scrollParent(element: Element) {
	for (let node = element.parentElement; node; node = node.parentElement) {
		if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
	}
	return null;
}

/**
 * Whether an element is on screen or within `margin` of it, in its scroll container;
 * null until first measured. Without the observer, everything counts as near.
 */
export function useNearView(
	element: RefObject<Element | null>,
	margin = "50% 0px",
) {
	const [near, setNear] = useState<boolean | null>(null);
	useEffect(() => {
		const node = element.current;
		if (!node) return;
		if (typeof IntersectionObserver === "undefined") return setNear(true);
		// The scroll container is the root, so the margin extends past its clipped edges.
		const observer = new IntersectionObserver(
			([entry]) => setNear(entry?.isIntersecting ?? true),
			{ root: scrollParent(node), rootMargin: margin },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [element, margin]);
	return near;
}
