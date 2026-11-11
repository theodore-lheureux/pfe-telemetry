import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import { LineChartIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { formatMeasurement } from "../activity/format";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "../components/ui/empty";
import { Label } from "../components/ui/label";
import {
	NativeSelect,
	NativeSelectOptGroup,
	NativeSelectOption,
} from "../components/ui/native-select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui/table";
import { operationMessage } from "../lib/operation-message";
import { MutationFailure, unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import { runAnalyticsQuery } from "./analytics.functions";
import { useMetricAttributes } from "./catalog";
import { TimeseriesChart } from "./charts";
import {
	type AnalyticsQuery,
	type Calculation,
	type Combine,
	INTERVALS,
	type Interval,
	MAX_BUCKETS,
	type MetricDefinition,
	type QueryResult,
	RELATIVE_RANGES,
	type RelativeRange,
} from "./contracts";
import { attributeField } from "./fields";
import { InsightsHeader } from "./insights-header";
import { attributeLabel, metricDescription, metricLabel } from "./metric-names";
import { MetricPicker } from "./metric-picker";
import { ALLOWED_CALCULATIONS } from "./validation";

// Categorical colors are assigned in fixed order; series past the eighth stay in the
// table instead of reusing a hue.
const CHART_SERIES = 8;
const DEFAULT_INTERVAL: Record<RelativeRange, Interval> = {
	"15m": "10s",
	"1h": "1m",
	"6h": "5m",
	"24h": "15m",
	"7d": "1h",
	"30d": "1d",
};
const CALCULATION_LABEL: Record<Calculation, () => string> = {
	last: m.insight_calc_last,
	avg: m.insight_calc_avg,
	min: m.insight_calc_min,
	max: m.insight_calc_max,
	rate: m.insight_calc_rate,
	increase: m.insight_calc_increase,
};
const COMBINE_LABEL: Record<Combine, () => string> = {
	sum: m.insight_combine_sum,
	avg: m.insight_combine_avg,
	min: m.insight_combine_min,
	max: m.insight_combine_max,
};
const RANGE_LABEL: Record<RelativeRange, () => string> = {
	"15m": m.insight_range_15m,
	"1h": m.insight_range_1h,
	"6h": m.insight_range_6h,
	"24h": m.insight_range_24h,
	"7d": m.insight_range_7d,
	"30d": m.insight_range_30d,
};
const INTERVAL_LABEL: Record<Interval, () => string> = {
	"10s": m.insight_interval_10s,
	"1m": m.insight_interval_1m,
	"5m": m.insight_interval_5m,
	"15m": m.insight_interval_15m,
	"1h": m.insight_interval_1h,
	"1d": m.insight_interval_1d,
};

function fits(range: RelativeRange, interval: Interval) {
	return RELATIVE_RANGES[range] / INTERVALS[interval] <= MAX_BUCKETS;
}

/** Readable value with its unit; rates are per second of the stored unit. */
function formatValue(
	value: number | null,
	unit: string,
	calculation: Calculation,
	locale: string,
) {
	if (value === null) return "—";
	if (calculation === "rate") {
		const number = new Intl.NumberFormat(locale, {
			maximumFractionDigits: 3,
		}).format(value);
		// Seconds per second (such as CPU time) is a plain ratio, roughly busy cores.
		if (unit === "s" || !unit || unit === "1") return number;
		return `${number} ${unit}/s`;
	}
	if (Number.isInteger(value) || unit === "By" || unit === "s")
		return formatMeasurement(value, unit, locale).text;
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value)}${unit && unit !== "1" ? ` ${unit}` : ""}`;
}

export function InsightBuilder({
	userId,
	reference,
	metrics,
	nodes,
}: {
	userId: string;
	reference: ProjectReference;
	metrics: MetricDefinition[];
	nodes: { id: string; hostname: string }[];
}) {
	const hydrated = useHydrated();
	const locale = getLocale();
	const usable = useMemo(
		() =>
			metrics
				.filter((metric) => metric.behavior !== "unsupported")
				.sort((a, b) => metricLabel(a.name).localeCompare(metricLabel(b.name))),
		[metrics],
	);
	const [metric, setMetric] = useState<MetricDefinition | null>(null);
	const [calculation, setCalculation] = useState<Calculation>("avg");
	const [combine, setCombine] = useState<Combine>("avg");
	const [groupBy, setGroupBy] = useState("");
	const [range, setRange] = useState<RelativeRange>("1h");
	const [interval, setInterval] = useState<Interval>("1m");
	const nodeNames = useMemo(
		() => new Map(nodes.map((node) => [node.id, node.hostname])),
		[nodes],
	);
	const attributes = useMetricAttributes(
		userId,
		reference,
		metric?.name,
		metric !== null,
	);
	const query = useMemo<AnalyticsQuery | null>(
		() =>
			metric && {
				shape: "timeseries",
				range: { last: range },
				interval,
				measures: [
					{ name: "value", metric: metric.name, calculation, combine },
				],
				groupBy: groupBy ? [groupBy] : [],
			},
		[metric, range, interval, calculation, combine, groupBy],
	);
	const result = useQuery<QueryResult>({
		queryKey: ["analytics-query", userId, reference.projectId, query],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await runAnalyticsQuery({
					data: { ...reference, query: query as AnalyticsQuery },
					signal,
				}),
			),
		enabled: hydrated && query !== null,
		placeholderData: keepPreviousData,
		retry: false,
		staleTime: 0,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
	function choose(next: MetricDefinition) {
		setMetric(next);
		// Each kind starts on its most common calculation and combination.
		setCalculation(next.behavior === "gauge" ? "avg" : "rate");
		setCombine(next.behavior === "gauge" ? "avg" : "sum");
		setGroupBy("");
	}
	const label = (value: string | null) =>
		value === null
			? "—"
			: groupBy === "node"
				? (nodeNames.get(value) ?? value)
				: value;
	const data = result.data;
	const unit = data?.measures[0]?.unit ?? metric?.unit ?? "";
	const series = data?.series ?? [];
	const charted = series.slice(0, CHART_SERIES);
	const chartSeries = charted.map((entry, index) => ({
		key: `s${index}`,
		label: entry.group.length
			? label(entry.group[0])
			: metric
				? metricLabel(metric.name)
				: "",
		color: `var(--viz-${index + 1})`,
		points: entry.points.flatMap((point) =>
			point.bucketMs === null
				? []
				: [{ bucketMs: point.bucketMs, value: point.value }],
		),
	}));
	const hasPoints = chartSeries.some((entry) => entry.points.length > 0);
	const allowed = metric ? ALLOWED_CALCULATIONS[metric.behavior] : [];
	const pointAttributes = (attributes.data ?? []).filter(
		(attribute) => attribute.scope === "point",
	);
	const resourceAttributes = (attributes.data ?? []).filter(
		(attribute) => attribute.scope === "resource",
	);
	return (
		<section className="flex min-w-0 flex-col gap-5">
			<InsightsHeader tab="explore" reference={reference} />
			{usable.length === 0 ? (
				<Empty className="border border-dashed bg-card">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<LineChartIcon aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>
							<h2>{m.insight_no_metrics()}</h2>
						</EmptyTitle>
						<EmptyDescription>
							{m.insight_no_metrics_description()}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					<div className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="insight-metric">{m.insight_metric()}</Label>
							<MetricPicker
								id="insight-metric"
								labelled
								metrics={usable}
								value={metric?.name}
								disabled={!hydrated}
								placeholder={m.insight_metric_choose()}
								className="w-full sm:w-80"
								onChange={(name) => {
									const next = usable.find((entry) => entry.name === name);
									if (next) choose(next);
								}}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="insight-calculation">
								{m.insight_calculation()}
							</Label>
							<NativeSelect
								id="insight-calculation"
								value={calculation}
								disabled={!metric}
								onChange={(event) =>
									setCalculation(event.target.value as Calculation)
								}
							>
								{allowed.map((value) => (
									<NativeSelectOption key={value} value={value}>
										{CALCULATION_LABEL[value]()}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="insight-combine">{m.insight_combine()}</Label>
							<NativeSelect
								id="insight-combine"
								value={combine}
								disabled={!metric}
								onChange={(event) => setCombine(event.target.value as Combine)}
							>
								{(Object.keys(COMBINE_LABEL) as Combine[]).map((value) => (
									<NativeSelectOption key={value} value={value}>
										{COMBINE_LABEL[value]()}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="insight-group">{m.insight_group_by()}</Label>
							<NativeSelect
								id="insight-group"
								value={groupBy}
								disabled={!metric}
								onChange={(event) => setGroupBy(event.target.value)}
							>
								<NativeSelectOption value="">
									{m.insight_group_none()}
								</NativeSelectOption>
								<NativeSelectOption value="node">
									{m.insight_group_node()}
								</NativeSelectOption>
								<NativeSelectOption value="host">
									{m.insight_group_host()}
								</NativeSelectOption>
								<NativeSelectOption value="resource.id">
									{m.insight_group_resource()}
								</NativeSelectOption>
								{pointAttributes.length > 0 && (
									<NativeSelectOptGroup label={m.insight_group_attributes()}>
										{pointAttributes.map((attribute) => (
											<NativeSelectOption
												key={`point/${attribute.key}`}
												value={attributeField("point", attribute.key)}
											>
												{attributeLabel(attribute.key)}
											</NativeSelectOption>
										))}
									</NativeSelectOptGroup>
								)}
								{resourceAttributes.length > 0 && (
									<NativeSelectOptGroup
										label={m.insight_group_resource_attributes()}
									>
										{resourceAttributes.map((attribute) => (
											<NativeSelectOption
												key={`resource/${attribute.key}`}
												value={attributeField("resource", attribute.key)}
											>
												{attributeLabel(attribute.key)}
											</NativeSelectOption>
										))}
									</NativeSelectOptGroup>
								)}
							</NativeSelect>
						</div>
						<div className="flex flex-col gap-1.5 sm:ml-auto">
							<Label htmlFor="insight-range">{m.insight_range()}</Label>
							<NativeSelect
								id="insight-range"
								value={range}
								onChange={(event) => {
									const next = event.target.value as RelativeRange;
									setRange(next);
									if (!fits(next, interval))
										setInterval(DEFAULT_INTERVAL[next]);
								}}
							>
								{(Object.keys(RANGE_LABEL) as RelativeRange[]).map((value) => (
									<NativeSelectOption key={value} value={value}>
										{RANGE_LABEL[value]()}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="insight-interval">{m.insight_interval()}</Label>
							<NativeSelect
								id="insight-interval"
								value={interval}
								onChange={(event) =>
									setInterval(event.target.value as Interval)
								}
							>
								{(Object.keys(INTERVAL_LABEL) as Interval[])
									.filter((value) => fits(range, value))
									.map((value) => (
										<NativeSelectOption key={value} value={value}>
											{INTERVAL_LABEL[value]()}
										</NativeSelectOption>
									))}
							</NativeSelect>
						</div>
					</div>
					{metric && metricDescription(metric.name) && (
						<p className="-mt-2 text-sm text-muted-foreground">
							{metricDescription(metric.name)}
						</p>
					)}
					{!metric ? (
						<Empty className="border border-dashed bg-card">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<LineChartIcon aria-hidden="true" />
								</EmptyMedia>
								<EmptyTitle>
									<h2>{m.insight_metric_choose()}</h2>
								</EmptyTitle>
							</EmptyHeader>
						</Empty>
					) : result.isError ? (
						<div
							role="alert"
							className="rounded-md border border-destructive/40 p-4 text-sm"
						>
							{result.error instanceof MutationFailure
								? operationMessage(result.error.failure)
								: m.insight_unavailable()}
						</div>
					) : (
						<div
							aria-busy={result.isFetching}
							className="flex flex-col gap-3 rounded-md border bg-card p-4"
						>
							{result.isPending ? (
								<p
									role="status"
									className="py-16 text-center text-sm text-muted-foreground"
								>
									{m.insight_running()}
								</p>
							) : !hasPoints ? (
								<p className="py-16 text-center text-sm text-muted-foreground">
									{m.insight_empty_result()}
								</p>
							) : (
								<TimeseriesChart
									label={m.insight_chart({ metric: metricLabel(metric.name) })}
									bucketSeconds={data?.bucketSeconds ?? INTERVALS[interval]}
									format={(value) =>
										formatValue(value, unit, calculation, locale)
									}
									series={chartSeries}
								/>
							)}
							{(series.length > CHART_SERIES || data?.limited) && (
								<p className="text-xs text-muted-foreground">
									{data?.limited
										? m.insight_limited()
										: m.insight_chart_limited()}
								</p>
							)}
						</div>
					)}
					{metric && series.length > 0 && (
						<div className="rounded-md border bg-card">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{m.insight_series()}</TableHead>
										<TableHead className="text-right">
											{CALCULATION_LABEL[calculation]()}
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{series.map((entry, index) => {
										const latest = [...entry.points]
											.reverse()
											.find((point) => point.value !== null);
										return (
											<TableRow key={JSON.stringify(entry.group)}>
												<TableCell>
													<span className="flex items-center gap-2">
														<span
															aria-hidden="true"
															className="size-2 shrink-0 rounded-full"
															style={{
																background:
																	index < CHART_SERIES
																		? `var(--viz-${index + 1})`
																		: "var(--muted-foreground)",
															}}
														/>
														{entry.group.length
															? label(entry.group[0])
															: m.insight_all()}
													</span>
												</TableCell>
												<TableCell className="text-right font-mono tabular-nums">
													{formatValue(
														latest?.value ?? null,
														unit,
														calculation,
														locale,
													)}
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</div>
					)}
				</>
			)}
		</section>
	);
}
