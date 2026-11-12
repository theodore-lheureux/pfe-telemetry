import { m } from "@recount/i18n/messages";
import { DownloadIcon } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../../components/ui/table";
import type { QueryResult, SeriesResult } from "../contracts";
import { lineId, type SeriesView, stats } from "./series-view";

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

const TIMESERIES_COLUMNS = [
	m.insight_calc_last,
	m.insight_calc_avg,
	m.insight_calc_min,
	m.insight_calc_max,
	m.insight_stat_p95,
	m.insight_stat_p99,
];

/** Latest, average, minimum, maximum and percentiles per visible series, with CSV export. */
export function InsightTable({
	result,
	view,
	hydrated,
	onHover,
}: {
	result: QueryResult;
	view: SeriesView;
	hydrated: boolean;
	/** The line under the pointer, so the chart can emphasize it. */
	onHover: (line: string | null) => void;
}) {
	// A table-shaped result holds one value per series for the whole range.
	const total = result.shape === "table";
	const columns = total ? [m.insight_total] : TIMESERIES_COLUMNS;
	const values = (series: SeriesResult) => {
		const { latest, average, min, max, p95, p99 } = stats(series);
		return total ? [latest] : [latest, average, min, max, p95, p99];
	};
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-sm font-semibold">{m.insight_results()}</h2>
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
			<div className="rounded-md border bg-card">
				<Table aria-label={m.insight_results()}>
					<TableHeader>
						<TableRow>
							<TableHead>{m.insight_series()}</TableHead>
							{columns.map((column) => (
								<TableHead key={column()} className="text-right">
									{column()}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{view.visible.map((series) => (
							<TableRow
								key={lineId(series)}
								onMouseEnter={() => onHover(lineId(series))}
								onMouseLeave={() => onHover(null)}
							>
								<TableCell>
									<span className="flex items-center gap-2">
										<span
											aria-hidden="true"
											className="size-2.5 shrink-0 rounded-full"
											style={{
												background:
													view.color(series) ?? "var(--muted-foreground)",
												opacity: series.comparison ? 0.45 : 1,
											}}
										/>
										<span className="truncate">{view.label(series)}</span>
									</span>
								</TableCell>
								{values(series).map((value, index) => (
									<TableCell
										// Columns are fixed per shape, so position is their identity.
										// biome-ignore lint/suspicious/noArrayIndexKey: see above.
										key={index}
										className="text-right font-mono tabular-nums"
									>
										{view.format(series)(value)}
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
