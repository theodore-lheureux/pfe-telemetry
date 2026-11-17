/** Buckets a pointer has pressed and dragged across, in ms. */
export interface PointerSelection {
	start: number;
	end: number;
}

export interface PointerHandlers {
	/** Dragging across buckets narrows the range to them. */
	onZoom?: (from: number, to: number) => void;
	/** Clicking picks the bucket under the pointer. */
	onSelect?: (bucketMs: number) => void;
}

/** A press starts a selection only when the chart reacts to one. */
export function pressPointer(
	at: number | null,
	{ onZoom, onSelect }: PointerHandlers,
): PointerSelection | null {
	if (at === null || (!onZoom && !onSelect)) return null;
	return { start: at, end: at };
}

/** Only a zoomable chart extends a selection, so others never draw a band. */
export function dragPointer(
	selection: PointerSelection | null,
	at: number | null,
	{ onZoom }: PointerHandlers,
): PointerSelection | null {
	if (!selection || at === null || !onZoom) return selection;
	return { ...selection, end: at };
}

/** A release zooms to dragged buckets, through each one's end, or picks a clicked one. */
export function releasePointer(
	selection: PointerSelection | null,
	bucketSeconds: number,
	{ onZoom, onSelect }: PointerHandlers,
) {
	if (!selection) return;
	if (selection.start === selection.end) {
		onSelect?.(selection.start);
		return;
	}
	onZoom?.(
		Math.min(selection.start, selection.end),
		Math.max(selection.start, selection.end) + bucketSeconds * 1000,
	);
}

/**
 * Whether a plotted point has gaps on both sides, which a line or area alone would not
 * draw. Recharts marks a gap with a null `y` on lines, areas and stacks alike.
 */
export function isolated(
	points: readonly { y?: number | null }[],
	index: number,
) {
	const gap = (at: number) => points[at]?.y == null;
	return !gap(index) && gap(index - 1) && gap(index + 1);
}
