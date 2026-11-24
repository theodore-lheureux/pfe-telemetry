import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { CopyPlusIcon, InfoIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "../../components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../../components/ui/tooltip";
import type { ProjectReference } from "../../organizations/contracts";
import { AttributeFilter } from "../attribute-filter";
import { useMetricAttributes, useProcessCoverage } from "../catalog";
import {
	type Calculation,
	type Combine,
	MAX_FILTERS,
	type MetricDefinition,
} from "../contracts";
import { FilterChips, withFilter } from "../filter-chips";
import { isDistribution } from "../histograms";
import { isProcessDetailMetric, metricDescription } from "../metric-names";
import { MetricPicker } from "../metric-picker";
import { ALLOWED_CALCULATIONS } from "../validation";
import type { DraftSeries, InsightDraft } from "./draft";
import {
	COMBINE_GROUPS,
	COMBINE_OPTION_LABEL,
	calculationLabel,
} from "./labels";
import { InlineWarning } from "./percentile-warning";

// Borderless selects read as a phrase, "Rate per second  Sum of all sources", and wrap
// rather than truncate when the panel is narrow.
const INLINE =
	"h-7 shrink-0 border-transparent bg-transparent px-1.5 text-xs font-normal shadow-none hover:bg-muted dark:bg-transparent";

/** One lettered series: its metric, calculation, how groups combine, and its own filters. */
export function SeriesRow({
	userId,
	reference,
	series,
	color,
	metrics,
	disabled,
	removable,
	heatmap,
	scope,
	onChange,
	onRemove,
	onDuplicate,
}: {
	userId: string;
	reference: ProjectReference;
	series: DraftSeries;
	color: string;
	metrics: MetricDefinition[];
	disabled: boolean;
	removable: boolean;
	heatmap: boolean;
	/** The query's range and filters, which scope the process detail coverage. */
	scope: Pick<InsightDraft, "range" | "filters">;
	onChange: (series: DraftSeries) => void;
	onRemove: () => void;
	/** Adds a copy below, such as to plot another percentile; absent when no letter is left. */
	onDuplicate?: () => void;
}) {
	const [wantsAttributes, setWantsAttributes] = useState(false);
	const attributes = useMetricAttributes(
		userId,
		reference,
		series.metric,
		wantsAttributes && series.metric !== undefined,
	);
	const definition = metrics.find((metric) => metric.name === series.metric);
	const histogram = isDistribution(definition);
	const allowed = definition
		? ALLOWED_CALCULATIONS[histogram ? "histogram" : definition.behavior]
		: [];
	const fixedFilters = Math.max(
		0,
		...(definition?.calculated?.inputs.map(
			(input) => input.filters?.length ?? 0,
		) ?? []),
	);
	const detail = isProcessDetailMetric(series.metric);
	const { data: coverage } = useProcessCoverage(
		userId,
		reference,
		scope,
		detail,
	);
	// Percentiles across processes come from the distribution, which sees all of them.
	const combineGroups = detail ? COMBINE_GROUPS.slice(0, 1) : COMBINE_GROUPS;
	// A heatmap shows every bucket, so a histogram row has no calculation to choose.
	const controls = !(heatmap && histogram);
	const filter = (
		<AttributeFilter
			trigger="icon"
			attributes={attributes.data}
			loading={attributes.isFetching}
			values={{ userId, reference, metric: series.metric }}
			disabled={disabled || series.filters.length + fixedFilters >= MAX_FILTERS}
			onOpen={() => setWantsAttributes(true)}
			onAdd={(filter) =>
				onChange({
					...series,
					filters: withFilter(series.filters, filter),
				})
			}
		/>
	);
	const description =
		definition?.note ||
		definition?.description ||
		(series.metric ? metricDescription(series.metric) : null);
	return (
		<div className="rounded-md border bg-background">
			<div className="flex items-center gap-1.5 p-1.5">
				<span
					aria-hidden="true"
					className="flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white"
					style={{ background: color }}
				>
					{series.name}
				</span>
				<MetricPicker
					metrics={metrics}
					value={series.metric}
					disabled={disabled}
					placeholder={m.insight_metric_choose()}
					className="h-8 min-w-0 flex-1 border-transparent px-2 shadow-none hover:bg-muted"
					onChange={(name) => {
						const next = metrics.find((metric) => metric.name === name);
						if (!next) return;
						if (isDistribution(next)) {
							onChange({
								...series,
								metric: next.name,
								calculation: "p95",
								combine: "sum",
								filters: [],
							});
							return;
						}
						if (next.calculated) {
							onChange({
								...series,
								metric: next.name,
								calculation: "last",
								combine: "sum",
								filters: [],
							});
							return;
						}
						// Each kind starts on its most common calculation and combination.
						const gauge = next.behavior === "gauge";
						onChange({
							...series,
							metric: next.name,
							calculation: gauge ? "avg" : "rate",
							combine: gauge ? "avg" : "sum",
							filters: [],
						});
					}}
				/>
				{definition?.calculated && (
					<Button
						asChild
						variant="ghost"
						size="icon-xs"
						aria-label={m.definitions_view_definition()}
					>
						<Link
							to="/organizations/$organizationId/projects/$projectId/definitions/metrics/$metric"
							params={{ ...reference, metric: definition.name }}
						>
							<InfoIcon aria-hidden="true" />
						</Link>
					</Button>
				)}
				{description && !definition?.calculated && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={m.insight_metric_about()}
								className="text-muted-foreground"
							>
								<InfoIcon aria-hidden="true" />
							</Button>
						</TooltipTrigger>
						<TooltipContent className="flex max-w-64 flex-col gap-1">
							<span>{description}</span>
							{coverage && (
								<span className="text-muted-foreground">
									{m.insight_process_coverage(coverage)}
								</span>
							)}
						</TooltipContent>
					</Tooltip>
				)}
				{definition && !controls && filter}
				{onDuplicate && (
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={m.insight_series_duplicate({ name: series.name })}
						title={m.insight_series_duplicate({ name: series.name })}
						className="text-muted-foreground"
						disabled={disabled}
						onClick={onDuplicate}
					>
						<CopyPlusIcon aria-hidden="true" />
					</Button>
				)}
				{removable && (
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={m.insight_series_remove({ name: series.name })}
						className="text-muted-foreground"
						disabled={disabled}
						onClick={onRemove}
					>
						<XIcon aria-hidden="true" />
					</Button>
				)}
			</div>
			{definition && controls && (
				<div className="flex items-start gap-0.5 border-t px-1.5 py-1">
					{definition.calculated && (
						<span className="flex-1 self-center px-1.5 text-xs text-muted-foreground">
							{m.calculated_metric()}
						</span>
					)}
					{!definition.calculated && (
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
							<Select
								value={series.calculation}
								disabled={disabled}
								onValueChange={(value) =>
									onChange({ ...series, calculation: value as Calculation })
								}
							>
								<SelectTrigger
									size="sm"
									aria-label={m.insight_calculation()}
									className={INLINE}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper" align="start">
									{allowed.map((value) => (
										<SelectItem key={value} value={value}>
											{calculationLabel(value, definition?.unit)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{!histogram && (
								<Select
									value={series.combine}
									disabled={disabled}
									onValueChange={(value) =>
										onChange({ ...series, combine: value as Combine })
									}
								>
									<SelectTrigger
										size="sm"
										aria-label={m.insight_combine()}
										className={INLINE}
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent position="popper" align="start">
										<p className="max-w-64 px-1.5 py-1 text-xs text-muted-foreground">
											{m.insight_combine_help()}
										</p>
										{combineGroups.map((group) => (
											<SelectGroup key={group.values[0]}>
												<SelectLabel>{group.label()}</SelectLabel>
												{group.values.map((value) => (
													<SelectItem key={value} value={value}>
														{COMBINE_OPTION_LABEL[value]()}
													</SelectItem>
												))}
											</SelectGroup>
										))}
									</SelectContent>
								</Select>
							)}
						</div>
					)}
					<span className="shrink-0">{filter}</span>
				</div>
			)}
			{coverage && coverage.deferred > 0 && (
				<InlineWarning className="border-t px-3 py-1.5">
					{m.insight_process_deferred()}
				</InlineWarning>
			)}
			{series.filters.length > 0 && (
				<div className="flex flex-wrap gap-1.5 border-t p-1.5">
					<FilterChips
						filters={series.filters}
						disabled={disabled}
						onChange={(filters) => onChange({ ...series, filters })}
					/>
				</div>
			)}
		</div>
	);
}
