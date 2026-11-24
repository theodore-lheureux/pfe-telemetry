import { m } from "@recount/i18n/messages";
import {
	type ColumnDef,
	createSortedRowModel,
	rowSortingFeature,
	sortFn_basic,
	sortFn_text,
	tableFeatures,
} from "@tanstack/react-table";
import { SortableHeader } from "../../components/data-table";
import type { SeriesResult } from "../contracts";
import { type SeriesView, stats } from "./series-view";

export const insightTableFeatures = tableFeatures({
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	sortFns: { basic: sortFn_basic, text: sortFn_text },
});

export interface InsightTableRow {
	series: SeriesResult;
	label: string;
	stats: ReturnType<typeof stats>;
}

export interface InsightTableMeta {
	view: SeriesView;
	embedded: boolean;
	precision: ReadonlyMap<keyof InsightTableRow["stats"], number>;
}

type Column = ColumnDef<typeof insightTableFeatures, InsightTableRow>;
const STAT_COLUMNS = [
	["latest", m.insight_calc_last],
	["average", m.insight_calc_avg],
	["min", m.insight_calc_min],
	["max", m.insight_calc_max],
	["p95", m.insight_stat_p95],
	["p99", m.insight_stat_p99],
] as const;

const seriesColumn: Column = {
	id: "series",
	accessorFn: (row) => row.label,
	sortFn: "text",
	sortDescFirst: false,
	header: ({ column }) => (
		<SortableHeader label={m.insight_series()} column={column} showUnsorted />
	),
	cell: ({ row, table }) => {
		const { view, embedded } = table.options.meta as InsightTableMeta;
		const series = row.original.series;
		return (
			<span className="flex items-center gap-2">
				{!embedded && (
					<span
						aria-hidden="true"
						className="size-2.5 shrink-0 rounded-full"
						style={{
							background: view.color(series) ?? "var(--muted-foreground)",
							opacity: series.comparison ? 0.45 : 1,
						}}
					/>
				)}
				<span className="truncate">{row.original.label}</span>
			</span>
		);
	},
};

/** A header naming the subject the cells count, such as "Latest (busy processes)". */
function withSubject(label: string, { view }: InsightTableMeta) {
	return view.subject ? `${label} (${view.subject})` : label;
}

function numericColumn(
	key: keyof InsightTableRow["stats"],
	label: () => string,
): Column {
	return {
		id: key,
		accessorFn: (row) => row.stats[key] ?? undefined,
		sortFn: "basic",
		sortUndefined: "last",
		sortDescFirst: true,
		meta: { className: "text-right" },
		header: ({ column, table }) => (
			<SortableHeader
				label={withSubject(label(), table.options.meta as InsightTableMeta)}
				column={column}
				className="ml-auto -mr-2"
				showUnsorted
			/>
		),
		cell: ({ row, table }) => {
			const { view, precision } = table.options.meta as InsightTableMeta;
			return (
				<span className="block text-right font-mono tabular-nums">
					{
						view.formatShort(row.original.series)(
							row.original.stats[key],
							precision.get(key),
						).text
					}
				</span>
			);
		},
	};
}

export const insightTotalColumns: Column[] = [
	seriesColumn,
	numericColumn("latest", m.insight_total),
];

export const insightTimeseriesColumns: Column[] = [
	seriesColumn,
	...STAT_COLUMNS.map(([key, label]) => numericColumn(key, label)),
];

export function insightTableRows(view: SeriesView): InsightTableRow[] {
	return view.visible.map((series) => ({
		series,
		label: view.label(series),
		stats: stats(series),
	}));
}

export function insightTablePrecision(
	rows: InsightTableRow[],
	view: SeriesView,
) {
	return new Map(
		STAT_COLUMNS.map(([key]) => [
			key,
			Math.max(
				0,
				...rows.map(
					(row) =>
						view.formatDetails(row.series)(row.stats[key]).fractionDigits,
				),
			),
		]),
	);
}
