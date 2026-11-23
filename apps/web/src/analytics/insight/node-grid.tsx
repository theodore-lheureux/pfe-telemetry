import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import type { QueryResult } from "../contracts";
import { heatColor } from "../histograms";
import { distributionLabels } from "../metric-names";
import { bucketGrid } from "./grid";
import type { SeriesView } from "./series-view";

const ROW_HEIGHT = 32;
const VIEW_HEIGHT = 384;

export function NodeGrid({
	result,
	view,
	zone,
	onNode,
}: {
	result: QueryResult;
	view: SeriesView;
	zone: string;
	onNode?: (host: string) => void;
}) {
	const [scroll, setScroll] = useState(0);
	const measure = result.measures[0];
	const labels = measure && distributionLabels(measure.metric, measure.label);
	const quantity =
		labels &&
		m.histogram_percentile_quantity({
			quantity: labels.quantity,
			percentile: measure.calculation,
		});
	const buckets = bucketGrid(
		result.from,
		result.to,
		result.bucketSeconds ?? 60,
	);
	const first = Math.min(
		Math.max(0, view.current.length - 1),
		Math.max(0, Math.floor(scroll / ROW_HEIGHT) - 3),
	);
	const rows = view.current.slice(first, first + VIEW_HEIGHT / ROW_HEIGHT + 7);
	const time = new Intl.DateTimeFormat(getLocale(), {
		hour: "numeric",
		minute: "2-digit",
		timeZone: zone,
	});
	const peak = result.series.reduce(
		(max, row) =>
			row.points.reduce((best, point) => Math.max(best, point.value ?? 0), max),
		0,
	);
	if (view.empty) return <p>{m.histogram_empty()}</p>;
	return (
		<div className="space-y-2">
			<div className="flex justify-between px-2 text-xs text-muted-foreground">
				<span>{m.insight_grid_active()}</span>
				{quantity && <span>{m.histogram_value_intensity({ quantity })}</span>}
				<span>{time.formatRange(result.from, result.to)}</span>
			</div>
			<div
				className="overflow-auto rounded-md border"
				style={{ height: VIEW_HEIGHT }}
				onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
			>
				<div
					className="relative min-w-96"
					style={{ height: view.current.length * ROW_HEIGHT }}
				>
					<div
						className="absolute inset-x-0"
						style={{ top: first * ROW_HEIGHT }}
					>
						{rows.map((row) => {
							const host = row.group[0];
							const points = new Map(
								row.points.map(({ bucketMs, value }) => [bucketMs, value]),
							);
							const format = view.format(row);
							return (
								<div
									key={String(host)}
									className="flex items-center gap-2 border-b px-2"
									style={{ height: ROW_HEIGHT }}
								>
									<Button
										variant="ghost"
										size="sm"
										className="w-40 shrink-0 justify-start truncate"
										disabled={!host || !onNode}
										onClick={() => {
											if (host) onNode?.(host);
										}}
										aria-label={`${m.insight_grid_detail()}: ${host}`}
									>
										{host}
									</Button>
									<div
										className="grid h-5 min-w-0 flex-1 gap-px"
										style={{
											gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))`,
										}}
									>
										{buckets.map((bucket) => {
											const value = points.get(bucket);
											return (
												<span
													key={bucket}
													title={`${time.format(bucket)} · ${quantity ?? ""}: ${format(value ?? null)}`}
													style={{
														background:
															value == null
																? "var(--muted)"
																: heatColor(peak ? value / peak : 0),
													}}
												/>
											);
										})}
									</div>
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
}
