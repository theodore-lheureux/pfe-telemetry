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
import type { ChartType } from "../../charts";
import type { QueryResult } from "../../contracts";
import { type FormulaNames, plottedTitle } from "../labels";
import { NumberResults } from "../number-results";
import { SeriesGrid } from "../series-grid";
import { CartesianPanel } from "./cartesian-panel";
import { chartPolicy, DISPLAY_TYPES, type DisplayType } from "./chart-policy";
import { HeatmapPanel, heatmapTitle } from "./heatmap-panel";
import type { PanelProps } from "./types";

interface ChartEntry {
	label: () => string;
	icon: LucideIcon;
	render: (props: PanelProps) => ReactNode;
	title?: (result: QueryResult, names: FormulaNames) => string | null;
	limitsSeries?: boolean;
	handlesEmpty?: boolean;
}

const cartesian = (type: ChartType) => ({
	render: (props: PanelProps) => <CartesianPanel {...props} type={type} />,
	limitsSeries: true,
});
const registry: Record<DisplayType, ChartEntry> = {
	line: {
		...cartesian("line"),
		label: m.insight_display_line,
		icon: LineChartIcon,
	},
	area: {
		...cartesian("area"),
		label: m.insight_display_area,
		icon: AreaChartIcon,
	},
	bar: {
		...cartesian("bar"),
		label: m.insight_display_bar,
		icon: BarChart3Icon,
	},
	stacked: {
		...cartesian("stacked"),
		label: m.insight_display_stacked,
		icon: BarChartBigIcon,
	},
	heatmap: {
		label: m.insight_display_heatmap,
		icon: Grid2X2Icon,
		handlesEmpty: true,
		render: HeatmapPanel,
		title: heatmapTitle,
	},
	grid: {
		label: m.insight_display_grid,
		icon: LayoutGridIcon,
		render: ({ bucketSeconds, ...props }) => (
			<SeriesGrid {...props} step={bucketSeconds * 1000} />
		),
	},
	stat: {
		label: m.insight_display_stat,
		icon: HashIcon,
		render: ({ fill, ...props }) => <NumberResults {...props} compact={fill} />,
	},
	table: {
		label: m.insight_display_table,
		icon: TableIcon,
		render: () => null,
	},
};

export const chartTypes = DISPLAY_TYPES;
export const chartIcon = (type: DisplayType) => registry[type].icon;
export const chartLabel = (type: DisplayType) => registry[type].label();
export const chartTitle = (
	type: DisplayType,
	result: QueryResult,
	names: FormulaNames,
) => (registry[type].title ?? plottedTitle)(result, names);
export const chartLimitsSeries = (type: DisplayType) =>
	registry[type].limitsSeries;
export const chartHandlesEmpty = (type: DisplayType) =>
	registry[type].handlesEmpty;

export function chartChoices(histogram: boolean, grouped = true) {
	return chartTypes.filter((type) => {
		const policy = chartPolicy(type);
		return (
			(histogram || !policy.needsHistogram) && (grouped || !policy.needsGroupBy)
		);
	});
}

export function ChartPanel(props: PanelProps) {
	const Panel = registry[props.display.type].render;
	return <Panel {...props} />;
}
