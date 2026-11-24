import { m } from "@recount/i18n/messages";
import {
	AreaChartIcon,
	BarChart3Icon,
	BarChartBigIcon,
	Grid2X2Icon,
	HashIcon,
	LayoutGridIcon,
	LineChartIcon,
	type LucideIcon,
	TableIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { QueryResult } from "../../contracts";
import type { DisplayType } from "../draft";
import { type FormulaNames, plottedTitle } from "../labels";
import { NumberResults } from "../number-results";
import { SeriesGrid } from "../series-grid";
import { CartesianPanel } from "./cartesian-panel";
import { HeatmapPanel, heatmapTitle } from "./heatmap-panel";
import type { PanelProps } from "./types";

interface ChartEntry {
	label: () => string;
	icon: LucideIcon;
	render: (props: PanelProps) => ReactNode;
	title?: (result: QueryResult, names: FormulaNames) => string | null;
	needsHistogram?: boolean;
	needsGroupBy?: boolean;
	reducesSeries?: boolean;
	limitsSeries?: boolean;
}

const cartesian = { render: CartesianPanel, limitsSeries: true };
const registry: Record<DisplayType, ChartEntry> = {
	line: { ...cartesian, label: m.insight_display_line, icon: LineChartIcon },
	area: { ...cartesian, label: m.insight_display_area, icon: AreaChartIcon },
	bar: { ...cartesian, label: m.insight_display_bar, icon: BarChart3Icon },
	stacked: {
		...cartesian,
		label: m.insight_display_stacked,
		icon: BarChartBigIcon,
	},
	heatmap: {
		label: m.insight_display_heatmap,
		icon: Grid2X2Icon,
		needsHistogram: true,
		render: HeatmapPanel,
		title: heatmapTitle,
	},
	grid: {
		label: m.insight_display_grid,
		icon: LayoutGridIcon,
		needsGroupBy: true,
		render: ({ bucketSeconds, ...props }) => (
			<SeriesGrid {...props} step={bucketSeconds * 1000} />
		),
	},
	stat: {
		label: m.insight_display_stat,
		icon: HashIcon,
		reducesSeries: true,
		render: ({ fill, ...props }) => <NumberResults {...props} compact={fill} />,
	},
	table: {
		label: m.insight_display_table,
		icon: TableIcon,
		render: () => null,
	},
};

export const chartTypes = Object.keys(registry) as DisplayType[];
export const chartIcon = (type: DisplayType) => registry[type].icon;
export const chartLabel = (type: DisplayType) => registry[type].label();
export const chartTitle = (
	type: DisplayType,
	result: QueryResult,
	names: FormulaNames,
) => (registry[type].title ?? plottedTitle)(result, names);
export const chartLimitsSeries = (type: DisplayType) =>
	registry[type].limitsSeries;

export function chartChoices(histogram: boolean, grouped = true) {
	return chartTypes.filter(
		(type) =>
			(histogram || !registry[type].needsHistogram) &&
			(grouped || !registry[type].needsGroupBy),
	);
}

export function ChartPanel(props: PanelProps) {
	const Panel = registry[props.display.type].render;
	return <Panel {...props} />;
}
