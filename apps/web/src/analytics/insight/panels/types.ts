import type { ReactNode } from "react";
import type { Heatmap } from "../../chart-heatmap";
import type { ChartPoint, ChartSeries } from "../../charts";
import type { QueryResult, SeriesResult } from "../../contracts";
import type { Display } from "../draft";
import type { SeriesView } from "../series-view";

export interface PanelProps {
	result: QueryResult;
	view: SeriesView;
	display: Display;
	bucketSeconds: number;
	pointsOf: (series: SeriesResult) => ChartPoint[];
	gapLabel: (series: SeriesResult, bucketMs: number) => string | null;
	height: string;
	fill: boolean;
	emptyDetail?: string;
	onGroup?: (series: SeriesResult) => void;
	timeline: (
		series: ChartSeries[],
		heatmap?: Heatmap & { quantity: string; format: (value: number) => string },
	) => ReactNode;
}
