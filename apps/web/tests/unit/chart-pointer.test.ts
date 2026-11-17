import { expect, test } from "bun:test";
import {
	dragPointer,
	isolated,
	type PointerHandlers,
	type PointerSelection,
	pressPointer,
	releasePointer,
} from "../../src/analytics/chart-pointer";

/** Presses at the first bucket, moves over the rest, then releases. */
function gesture(handlers: PointerHandlers, ...buckets: number[]) {
	let selection: PointerSelection | null = pressPointer(
		buckets[0] ?? null,
		handlers,
	);
	const pressed = selection;
	for (const at of buckets.slice(1))
		selection = dragPointer(selection, at, handlers);
	releasePointer(selection, 60, handlers);
	return { pressed, released: selection };
}

function recorder() {
	const zooms: [number, number][] = [];
	const selects: number[] = [];
	return {
		zooms,
		selects,
		onZoom: (from: number, to: number) => zooms.push([from, to]),
		onSelect: (at: number) => selects.push(at),
	};
}

test("insight and dashboard charts still zoom by dragging, through the last bucket's end", () => {
	const { zooms, selects, onZoom } = recorder();
	expect(gesture({ onZoom }, 180_000, 120_000, 60_000).released).toEqual({
		start: 180_000,
		end: 60_000,
	});
	expect(zooms).toEqual([[60_000, 240_000]]);
	// A click without a drag neither zooms nor selects on a zoom-only chart.
	gesture({ onZoom }, 60_000);
	expect(zooms).toHaveLength(1);
	expect(selects).toEqual([]);
});

test("execution charts select the clicked bucket and never draw a zoom band", () => {
	const { zooms, selects, onSelect } = recorder();
	gesture({ onSelect }, 120_000);
	expect(selects).toEqual([120_000]);
	// Dragging keeps the pressed bucket instead of extending a band nobody can apply.
	expect(gesture({ onSelect }, 60_000, 120_000, 180_000).released).toEqual({
		start: 60_000,
		end: 60_000,
	});
	expect(selects).toEqual([120_000, 60_000]);
	expect(zooms).toEqual([]);
	// Static charts never start a selection.
	expect(pressPointer(60_000, {})).toBeNull();
	expect(pressPointer(null, { onSelect })).toBeNull();
});

test("a value between gaps is isolated on lines, areas and stacks, which mark gaps with a null y", () => {
	const points = [{ y: null }, { y: 10 }, { y: null }, { y: 12 }, { y: 14 }];
	expect(points.map((_, index) => isolated(points, index))).toEqual([
		false,
		true,
		false,
		false,
		false,
	]);
	// Ends of the series count as gaps.
	expect(isolated([{ y: 5 }], 0)).toBe(true);
	expect(isolated([{ y: 5 }, { y: 6 }], 1)).toBe(false);
});
