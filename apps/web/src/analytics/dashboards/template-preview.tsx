import { m } from "@recount/i18n/messages";
import { TriangleAlertIcon } from "lucide-react";
import { Card } from "../../components/ui/card";
import { cn } from "../../lib/utils";
import type { MetricDefinition } from "../contracts";
import {
	type DashboardTemplate,
	previewDashboard,
	templateCoverage,
} from "../dashboard-templates";
import { decodeDraft } from "../insight/draft";
import { chartIcon, chartLabel } from "../insight/panels/registry";
import {
	TILE_COLUMN_CLASS,
	TILE_HEIGHT_CLASS,
	TILE_WIDTH_CLASS,
} from "./dashboard-tile";

/** A small, query-free map of the layout the template creates. */
export function TemplatePreview({
	template,
	metrics,
}: {
	template: DashboardTemplate;
	metrics?: MetricDefinition[];
}) {
	const coverage = metrics && templateCoverage(template, metrics);
	const tiles = previewDashboard(template).tiles;
	const missing = coverage
		? tiles.filter((_, index) => !coverage.available[index])
		: [];
	return (
		<section
			aria-label={m.dashboard_templates_preview()}
			className="flex flex-col gap-2"
		>
			<h3 className="text-sm font-medium">{m.dashboard_templates_preview()}</h3>
			<div className="grid grid-flow-row-dense auto-rows-[0.75rem] grid-cols-1 gap-1.5 rounded-lg bg-muted p-2 lg:grid-cols-12">
				{tiles.map((tile, index) => {
					const type = decodeDraft(tile.insight.draft).display.type;
					const Icon = chartIcon(type);
					const unavailable = coverage && !coverage.available[index];
					return (
						<Card
							key={tile.id}
							title={chartLabel(type)}
							className={cn(
								"min-w-0 flex-row items-start gap-1.5 rounded-md px-2 py-1.5 text-xs shadow-none",
								TILE_WIDTH_CLASS[tile.width],
								TILE_HEIGHT_CLASS[tile.height],
								tile.column && TILE_COLUMN_CLASS[tile.column],
								unavailable && "border-dashed text-muted-foreground",
							)}
						>
							{unavailable ? (
								<TriangleAlertIcon
									aria-hidden="true"
									className="size-3.5 shrink-0 text-amber-700 dark:text-amber-400"
								/>
							) : (
								<Icon
									aria-hidden="true"
									className="size-3.5 shrink-0 text-muted-foreground"
								/>
							)}
							<span className="truncate">{tile.insight.name}</span>
						</Card>
					);
				})}
			</div>
			{missing.length > 0 && (
				<p className="text-xs text-muted-foreground">
					{m.dashboard_templates_missing({
						panels: missing.map((tile) => tile.insight.name).join(", "),
					})}
				</p>
			)}
		</section>
	);
}
