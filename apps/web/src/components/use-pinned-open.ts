import { useRef, useState, type WheelEvent } from "react";

/** The nearest ancestor that scrolls vertically. */
function scrollParent(element: Element | null) {
	for (let node = element?.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if (/auto|scroll/.test(overflowY) && node.scrollHeight > node.clientHeight)
			return node;
	}
	return null;
}

/**
 * Open state for a tooltip or hover card that also pins open on click: hovering or
 * focusing shows it briefly, a click keeps it open until the trigger is clicked
 * again, Escape is pressed or the pointer goes down elsewhere.
 */
export function usePinnedOpen() {
	const [pinned, setPinned] = useState(false);
	const [hovered, setHovered] = useState(false);
	const ref = useRef<HTMLButtonElement>(null);
	const close = () => {
		setPinned(false);
		setHovered(false);
	};
	return {
		/** For the root's `open` and `onOpenChange`. */
		root: {
			open: pinned || hovered,
			onOpenChange: setHovered,
		},
		/** For the trigger. */
		trigger: {
			ref,
			// Radix closes these on pointer down; the click decides instead.
			onPointerDown: (event: { preventDefault: () => void }) =>
				event.preventDefault(),
			onClick: () => {
				if (pinned) close();
				else setPinned(true);
			},
		},
		/** For the content: dismissing it also unpins it. */
		content: {
			onEscapeKeyDown: close,
			// The popup renders outside the page's scroll area, so the wheel over it would
			// scroll nothing; it scrolls the area holding the trigger instead.
			onWheel: (event: WheelEvent<HTMLElement>) => {
				const content = event.currentTarget;
				if (content.scrollHeight > content.clientHeight) return;
				scrollParent(ref.current)?.scrollBy({
					top: event.deltaY,
					left: event.deltaX,
				});
			},
			// The trigger's own click toggles the pin, so its pointer down is not outside.
			onPointerDownOutside: (event: { target: EventTarget | null }) => {
				if (!ref.current?.contains(event.target as Node)) close();
			},
		},
	};
}
