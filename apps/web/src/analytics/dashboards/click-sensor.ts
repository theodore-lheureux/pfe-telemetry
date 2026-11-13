import type { SensorInstance, SensorProps } from "@dnd-kit/core";
import type { PointerEvent as ReactPointerEvent } from "react";

/** Controls inside a tile's header keep their own clicks. */
const INTERACTIVE = "a, button, input, select, textarea, [role='menuitem']";
/**
 * Picks a tile up on pressing its header and keeps it picked up after the button is
 * released, so it can be dragged or carried while the page scrolls; the next click
 * drops it. Escape puts it back. Keyboard users move tiles from the tile's menu.
 */
export class ClickSensor implements SensorInstance {
	autoScrollEnabled = true;

	static activators = [
		{
			eventName: "onPointerDown" as const,
			handler: ({ nativeEvent: event }: ReactPointerEvent) =>
				event.isPrimary &&
				event.button === 0 &&
				!(event.target as Element).closest(INTERACTIVE),
		},
	];

	private readonly document: Document;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly props: SensorProps<object>) {
		const event = props.event as PointerEvent;
		this.document = (event.target as Node).ownerDocument ?? document;
		props.onStart({ x: event.clientX, y: event.clientY });
		this.document.addEventListener("pointermove", this.move);
		this.document.addEventListener("pointerup", this.release, true);
		this.document.addEventListener("keydown", this.key, true);
	}

	private readonly move = (event: PointerEvent) =>
		this.props.onMove({ x: event.clientX, y: event.clientY });

	private readonly release = () => {
		this.document.removeEventListener("pointerup", this.release, true);
		// The press's own click follows its release; it neither drops the tile nor opens
		// what lies under it. The next click drops the tile.
		this.document.addEventListener("click", this.swallow, true);
		this.timer = setTimeout(() => {
			this.document.removeEventListener("click", this.swallow, true);
			this.document.addEventListener("click", this.drop, true);
		});
	};

	private readonly swallow = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
	};

	private readonly drop = (event: MouseEvent) => {
		this.swallow(event);
		this.finish();
		this.props.onEnd();
	};

	private readonly key = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		this.finish();
		this.props.onCancel();
	};

	private finish() {
		clearTimeout(this.timer);
		this.document.removeEventListener("pointermove", this.move);
		this.document.removeEventListener("pointerup", this.release, true);
		this.document.removeEventListener("click", this.swallow, true);
		this.document.removeEventListener("click", this.drop, true);
		this.document.removeEventListener("keydown", this.key, true);
	}
}
