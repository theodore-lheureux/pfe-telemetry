import { m } from "@recount/i18n/messages";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "../../components/ui/button";
import type { ProjectReference } from "../../organizations/contracts";
import { AttributeFilter } from "../attribute-filter";
import { useMetricAttributes } from "../catalog";
import type { MetricDefinition } from "../contracts";
import { FilterChips, withFilter } from "../filter-chips";
import {
	type InsightDraft,
	newSeries,
	nextSeriesName,
	removeSeries,
} from "./draft";
import { FormulaFields } from "./formula-fields";
import { GroupByFields } from "./group-by-fields";
import { applyPreset, availablePresets } from "./presets";
import { SeriesRow } from "./series-row";

function Section({
	title,
	action,
	children,
}: {
	title: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-2 border-b p-3 last:border-b-0">
			<div className="flex min-h-7 items-center justify-between gap-2">
				<h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
					{title}
				</h2>
				{action}
			</div>
			{children}
		</section>
	);
}

/** What to measure: series, an optional formula, query-wide filters and the breakdown. */
export function QueryPanel({
	userId,
	reference,
	draft,
	metrics,
	disabled,
	onChange,
}: {
	userId: string;
	reference: ProjectReference;
	draft: InsightDraft;
	metrics: MetricDefinition[];
	disabled: boolean;
	onChange: (draft: InsightDraft) => void;
}) {
	const [wantsAttributes, setWantsAttributes] = useState(false);
	// Query-wide filters and breakdowns can use any attribute in the project.
	const attributes = useMetricAttributes(
		userId,
		reference,
		undefined,
		wantsAttributes,
	);
	const next = nextSeriesName(draft.series);
	const presets = availablePresets(metrics);
	return (
		<div className="flex flex-col rounded-lg border bg-card">
			<Section
				title={m.insight_series()}
				action={
					next && (
						<Button
							variant="ghost"
							size="sm"
							disabled={disabled}
							onClick={() =>
								onChange({
									...draft,
									series: [...draft.series, newSeries(next)],
								})
							}
						>
							<PlusIcon aria-hidden="true" />
							{m.insight_series_add()}
						</Button>
					)
				}
			>
				{draft.series.map((series, index) => (
					<SeriesRow
						key={series.name}
						userId={userId}
						reference={reference}
						series={series}
						color={`var(--viz-${(index % 8) + 1})`}
						metrics={metrics}
						disabled={disabled}
						removable={draft.series.length > 1}
						onChange={(updated) =>
							onChange({
								...draft,
								// An edited series no longer belongs to its calculated metric.
								series: draft.series.map((entry) =>
									entry.name === series.name
										? { ...updated, source: undefined }
										: entry,
								),
							})
						}
						presets={presets.map((preset) => ({
							preset,
							fits: applyPreset(draft, preset, series.name) !== null,
						}))}
						onPreset={(preset) => {
							const next = applyPreset(draft, preset, series.name);
							if (next) onChange(next);
						}}
						onRemove={() => onChange(removeSeries(draft, series.name))}
					/>
				))}
				<FormulaFields draft={draft} disabled={disabled} onChange={onChange} />
			</Section>
			<Section
				title={m.insight_filters()}
				action={
					<AttributeFilter
						trigger="ghost"
						attributes={attributes.data}
						loading={attributes.isFetching}
						disabled={disabled}
						onOpen={() => setWantsAttributes(true)}
						onAdd={(filter) =>
							onChange({ ...draft, filters: withFilter(draft.filters, filter) })
						}
					/>
				}
			>
				{draft.filters.length > 0 ? (
					<div className="flex flex-wrap gap-1.5">
						<FilterChips
							filters={draft.filters}
							disabled={disabled}
							onChange={(filters) => onChange({ ...draft, filters })}
						/>
					</div>
				) : (
					<p className="text-xs text-muted-foreground">
						{m.insight_filters_none()}
					</p>
				)}
			</Section>
			<Section title={m.insight_group_by()}>
				<GroupByFields
					draft={draft}
					attributes={attributes.data}
					disabled={disabled}
					onOpen={() => setWantsAttributes(true)}
					onChange={onChange}
				/>
			</Section>
		</div>
	);
}
