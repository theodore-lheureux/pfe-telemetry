import type { Compactor, Layout, LayoutItem } from "react-grid-layout";
import { getAllCollisions } from "react-grid-layout/core";
import { fastVerticalCompactor } from "react-grid-layout/extras";

export type GridResize = {
	id: string;
	baseline: Layout;
};

export function dashboardCompactor(resize: () => GridResize | null): Compactor {
	return {
		...fastVerticalCompactor,
		compact(layout, cols) {
			const current = resize();
			const active = current && layout.find((item) => item.i === current.id);
			const adjusted =
				current && active
					? fitResizeNeighbor(layout, current.baseline, active)
					: layout;
			return fastVerticalCompactor.compact(adjusted, cols);
		},
	};
}

function fitResizeNeighbor(
	layout: Layout,
	baseline: Layout,
	active: LayoutItem,
): Layout {
	const old = baseline.find((item) => item.i === active.i);
	if (!old) return layout;
	const right = active.x + active.w;
	const oldRight = old.x + old.w;
	const expandingRight = right > oldRight;
	if (!expandingRight && active.x >= old.x) return layout;
	const neighbor = getAllCollisions(baseline, active)
		.filter(
			(item) =>
				!item.static &&
				(expandingRight ? item.x >= oldRight : item.x + item.w <= old.x),
		)
		.sort((a, b) => (expandingRight ? a.x - b.x : b.x + b.w - a.x - a.w))[0];
	if (!neighbor) return layout;
	const x = expandingRight ? right : neighbor.x;
	const w = expandingRight ? neighbor.x + neighbor.w - right : active.x - x;
	if (w < (neighbor.minW ?? 1)) return layout;
	return layout.map((item) =>
		item.i === neighbor.i ? { ...item, x, y: neighbor.y, w } : item,
	);
}
