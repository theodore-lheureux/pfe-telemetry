import { m } from "@recount/i18n/messages";
import { type SortingState, useTable } from "@tanstack/react-table";
import { DownloadIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { DataTable } from "../../components/data-table";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { capabilities } from "../capabilities";
import type { QueryResult, SeriesResult } from "../contracts";
import {
	type InsightTableMeta,
	insightTableFeatures,
	insightTablePrecision,
	insightTableRows,
	insightTimeseriesColumns,
	insightTotalColumns,
} from "./insight-table-columns";
import { lineId, type SeriesView } from "./series-view";

function exportCsv(
	series: SeriesResult[],
	label: (series: SeriesResult) => string,
) {
	const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;
	const lines = ["series,bucket,value"];
	for (const entry of series)
		for (const point of entry.points)
			lines.push(
				[
					quote(label(entry)),
					point.bucketMs === null ? "" : new Date(point.bucketMs).toISOString(),
					point.value ?? "",
				].join(","),
			);
	const url = URL.createObjectURL(
		new Blob([`${lines.join("\n")}\n`], { type: "text/csv" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = "insight.csv";
	link.click();
	URL.revokeObjectURL(url);
}

/** Latest, average, minimum, maximum and percentiles per visible series, with CSV export. */
export function InsightTable({
	result,
	view,
	hydrated,
	onHover,
	embedded = false,
}: {
	result: QueryResult;
	view: SeriesView;
	hydrated: boolean;
	/** A dashboard tile already supplies the frame, title and export menu. */
	embedded?: boolean;
	/** The line under the pointer, so the chart can emphasize it. */
	onHover: (line: string | null) => void;
}) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const percentiles = result.measures.every(
		(series) => capabilities(series).percentileOfSeries,
	);
	const columns = useMemo(() => {
		const all =
			result.shape === "table" ? insightTotalColumns : insightTimeseriesColumns;
		// Percentiles of percentile series would read as one more percentile.
		return percentiles
			? all.filter(({ id }) => id !== "p95" && id !== "p99")
			: all;
	}, [result.shape, percentiles]);
	const visibleSorting = useMemo(
		() =>
			sorting.filter((entry) =>
				columns.some((column) => column.id === entry.id),
			),
		[sorting, columns],
	);
	const rows = useMemo(() => insightTableRows(view), [view]);
	const precision = useMemo(
		() => insightTablePrecision(rows, view),
		[rows, view],
	);
	const meta: InsightTableMeta = { view, embedded, precision };
	const table = useTable({
		features: insightTableFeatures,
		data: rows,
		columns,
		meta,
		getRowId: (row) => lineId(row.series),
		state: { sorting: visibleSorting },
		onSortingChange: setSorting,
	});
	return (
		<div className={cn("flex min-h-0 flex-col", embedded ? "h-full" : "gap-3")}>
			{!embedded && (
				<div className="flex items-center justify-between gap-2">
					<h2 className="text-sm font-semibold">
						{m.insight_results()}
						{view.subject && (
							<span className="font-normal text-muted-foreground">
								{` · ${view.subject}`}
							</span>
						)}
					</h2>
					<Button
						variant="outline"
						size="sm"
						disabled={!hydrated || view.empty}
						onClick={() => exportCsv(view.visible, view.label)}
					>
						<DownloadIcon aria-hidden="true" />
						{m.insight_export()}
					</Button>
				</div>
			)}
			<DataTable
				table={table}
				label={m.insight_results()}
				embedded={embedded}
				onRowHover={(row) => onHover(row ? lineId(row.series) : null)}
			/>
		</div>
	);
}
