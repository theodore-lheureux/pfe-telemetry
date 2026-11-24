import { m } from "@recount/i18n/messages";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { IconEmptyState } from "../../../components/workspace";
import { cn } from "../../../lib/utils";
import { lineId } from "../series-view";
import { heatmapData, heatmapEmptyDetail } from "./heatmap-data";
import type { PanelProps } from "./types";

export function HeatmapPanel({
	result,
	view,
	fill,
	height,
	display,
	emptyDetail,
	timeline,
}: PanelProps) {
	const series = view.current.filter((item) => item.bounds);
	const hasCounts = series.some((item) =>
		item.points.some(({ counts }) => counts?.some((count) => count > 0)),
	);
	if (!hasCounts)
		return (
			<IconEmptyState
				icon={<ChartNoAxesColumnIcon aria-hidden="true" />}
				title={m.insight_empty_result()}
				description={heatmapEmptyDetail(result, emptyDetail)}
				className={height}
			/>
		);
	const multiple = new Set(series.map((item) => item.measure)).size > 1;
	return (
		<div
			className={cn("flex flex-col gap-4", fill && "h-full overflow-y-auto")}
		>
			{series.map((item) => {
				const heatmap = heatmapData(result, item, display);
				if (!heatmap) return null;
				const title = [multiple && heatmap.label, view.groupLabel(item)]
					.filter(Boolean)
					.join(" · ");
				return (
					<section
						key={lineId(item)}
						className={cn("flex flex-col gap-1", fill && "min-h-56 flex-1")}
					>
						{title && <h3 className="text-sm font-medium">{title}</h3>}
						{timeline([], heatmap)}
					</section>
				);
			})}
		</div>
	);
}
