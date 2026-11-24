import type { PanelProps } from "./types";

export function CartesianPanel({ view, pointsOf, timeline }: PanelProps) {
	const charting = view.visible.filter((series) => view.color(series));
	const points = charting.map(pointsOf);
	const values = points.map((series) =>
		JSON.stringify(series.map((point) => point.value)),
	);
	return timeline(
		charting.map((series, index) => ({
			key: `s${index}`,
			label: view.label(series),
			color: view.color(series) ?? "var(--viz-1)",
			comparison: series.comparison,
			coincident: values.indexOf(values[index]) < index,
			points: points[index],
		})),
	);
}
