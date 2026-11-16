import { m } from "@recount/i18n/messages";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "../../components/ui/button";
import type { ProjectReference } from "../../organizations/contracts";
import { AttributeFilter } from "../attribute-filter";
import type { CalculatedMetric } from "../calculated-metrics";
import { MAX_CALCULATED_INPUTS } from "../calculated-metrics";
import { useQueryAttributes } from "../catalog";
import type { MetricDefinition } from "../contracts";
import { FilterChips, withFilter } from "../filter-chips";
import {
	draftMetricNames,
	type InsightDraft,
	newSeries,
	nextSeriesName,
	removeSeries,
} from "./draft";
import { FormulaFields } from "./formula-fields";
import { GroupByFields } from "./group-by-fields";
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
	canWrite,
	editingCalculation,
}: {
	userId: string;
	reference: ProjectReference;
	draft: InsightDraft;
	metrics: MetricDefinition[];
	disabled: boolean;
	onChange: (draft: InsightDraft) => void;
	canWrite: boolean;
	editingCalculation?: CalculatedMetric;
}) {
	const [wantsAttributes, setWantsAttributes] = useState(false);
	// Query-wide filters and breakdowns can use any attribute in the project.
	const attributes = useQueryAttributes(
		userId,
		reference,
		draftMetricNames(draft),
		wantsAttributes,
	);
	let next = nextSeriesName(draft.series);
	if (editingCalculation && draft.series.length >= MAX_CALCULATED_INPUTS)
		next = null;
	return (
		<div className="flex flex-col rounded-lg border bg-card">
			<Section
				title={m.insight_series()}
				action={
					next &&
					(draft.display.type !== "stat" || draft.formulas.length > 0) && (
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
						onChange={(updated) => {
							const selected = metrics.find(
								(metric) => metric.name === updated.metric,
							);
							const changedCalculation =
								updated.metric !== series.metric && selected?.calculated;
							const base = { ...draft };
							if (changedCalculation) {
								delete base.groupBy;
								delete base.aggregate;
								const { spread: _spread, ...display } = base.display;
								base.display = display;
							}
							// A newly picked metric brings its default breakdown to a chart
							// that is not split yet.
							const breakdown =
								updated.metric !== series.metric &&
								draft.display.type !== "stat" &&
								!draft.groupBy &&
								draft.series.length === 1
									? metrics.find((metric) => metric.name === updated.metric)
											?.defaultBreakdown
									: undefined;
							onChange({
								...base,
								// An edited series no longer belongs to its calculated metric.
								series: draft.series.map((entry) =>
									entry.name === series.name ? updated : entry,
								),
								...(breakdown ? { groupBy: breakdown } : {}),
							});
						}}
						onRemove={() => onChange(removeSeries(draft, series.name))}
					/>
				))}
				<FormulaFields
					draft={draft}
					disabled={disabled}
					onChange={onChange}
					userId={userId}
					reference={reference}
					canWrite={canWrite}
					editingCalculation={editingCalculation}
				/>
			</Section>
			<Section
				title={m.insight_filters()}
				action={
					<AttributeFilter
						trigger="ghost"
						attributes={attributes.data}
						loading={attributes.isFetching}
						values={{ userId, reference }}
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
			{draft.display.type !== "stat" && (
				<Section title={m.insight_group_by()}>
					<GroupByFields
						draft={draft}
						attributes={attributes.data}
						disabled={disabled}
						onOpen={() => setWantsAttributes(true)}
						onChange={onChange}
					/>
				</Section>
			)}
		</div>
	);
}
