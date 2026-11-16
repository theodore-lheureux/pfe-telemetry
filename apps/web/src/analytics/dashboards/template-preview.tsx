import { m } from "@recount/i18n/messages";
import { Card, CardContent } from "../../components/ui/card";
import { cn } from "../../lib/utils";
import type { MetricDefinition } from "../contracts";
import {
	type DashboardTemplate,
	previewDashboard,
	templateCoverage,
} from "../dashboard-templates";
import { decodeDraft } from "../insight/draft";
import { DISPLAY_LABEL } from "../insight/labels";
import {
	TILE_COLUMN_CLASS,
	TILE_HEIGHT_CLASS,
	TILE_WIDTH_CLASS,
} from "./dashboard-tile";

/** A query-free preview of the actual saved layout and metric requirements. */
export function TemplatePreview({
	template,
	metrics,
}: {
	template: DashboardTemplate;
	metrics?: MetricDefinition[];
}) {
	const coverage = metrics && templateCoverage(template, metrics);
	return (
		<section
			aria-label={m.dashboard_templates_preview()}
			className="flex flex-col gap-2"
		>
			<p className="text-sm text-muted-foreground">
				{m.dashboard_templates_preview_description()}
			</p>
			{coverage && (
				<p className="text-sm">{m.dashboard_template_coverage(coverage)}</p>
			)}
			<div className="grid grid-flow-row-dense auto-rows-[minmax(3rem,auto)] grid-cols-1 gap-2 lg:grid-cols-12">
				{previewDashboard(template).tiles.map((tile, index) => {
					const draft = decodeDraft(tile.insight.draft);
					return (
						<Card
							key={tile.id}
							className={cn(
								"min-w-0",
								TILE_WIDTH_CLASS[tile.width],
								TILE_HEIGHT_CLASS[tile.height],
								tile.column && TILE_COLUMN_CLASS[tile.column],
							)}
						>
							<CardContent className="flex min-w-0 flex-col gap-1 p-3">
								<p className="break-words text-sm font-medium">
									{tile.insight.name}
								</p>
								<p className="text-xs text-muted-foreground">
									{DISPLAY_LABEL[draft.display.type]()}
								</p>
								{coverage && (
									<p className="text-xs text-muted-foreground">
										{coverage.available[index]
											? m.dashboard_templates_panel_available()
											: m.dashboard_templates_panel_unavailable()}
									</p>
								)}
							</CardContent>
						</Card>
					);
				})}
			</div>
		</section>
	);
}
