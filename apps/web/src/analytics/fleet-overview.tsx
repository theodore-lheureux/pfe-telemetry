import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	LayoutDashboardIcon,
	RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";
import { formatMeasurement } from "../activity/format";
import { Button } from "../components/ui/button";
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
	NativeSelectOption,
} from "../components/ui/native-select";
import { Skeleton } from "../components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui/table";
import { type OperationResult, unwrapOperation } from "../lib/operation-result";
import { cn } from "../lib/utils";
import type { ProjectReference } from "../organizations/contracts";
import { getFleetOverview } from "./analytics.functions";
import { Sparkline, TimeseriesChart } from "./charts";
import { InsightsHeader } from "./insights-header";
import type {
	Overview,
	OverviewMetric,
	OverviewRange,
	OverviewStat,
} from "./overview.server";

const RANGES: { value: OverviewRange; label: () => string }[] = [
	{ value: "1h", label: m.insight_range_1h },
	{ value: "24h", label: m.insight_range_24h },
	{ value: "7d", label: m.insight_range_7d },
];
const STAT_LABEL: Record<OverviewStat, () => string> = {
	nodes: m.stat_nodes,
	cpu: m.stat_cpu,
	memory: m.stat_memory,
	processes: m.stat_processes,
};
const STAT_DESCRIPTION: Record<OverviewStat, () => string> = {
	nodes: m.stat_nodes_description,
	cpu: m.stat_cpu_description,
	memory: m.stat_memory_description,
	processes: m.stat_processes_description,
};
const RATIOS = new Set<OverviewStat>(["cpu", "memory"]);

function formatStat(stat: OverviewStat, value: number | null, locale: string) {
	if (value === null) return "—";
	if (RATIOS.has(stat))
		return new Intl.NumberFormat(locale, {
			style: "percent",
			maximumFractionDigits: 1,
		}).format(value);
	return new Intl.NumberFormat(locale, {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

/** Percentage points for ratios, relative change for counts; neutral, not good or bad. */
function Delta({ metric, locale }: { metric: OverviewMetric; locale: string }) {
	if (metric.current === null || metric.previous === null) return null;
	const ratio = RATIOS.has(metric.stat);
	const change = ratio
		? (metric.current - metric.previous) * 100
		: metric.previous
			? (metric.current - metric.previous) / metric.previous
			: null;
	if (change === null || !Number.isFinite(change)) return null;
	const text = ratio
		? m.overview_points({
				value: new Intl.NumberFormat(locale, {
					maximumFractionDigits: 1,
					signDisplay: "exceptZero",
				}).format(change),
			})
		: new Intl.NumberFormat(locale, {
				style: "percent",
				maximumFractionDigits: 1,
				signDisplay: "exceptZero",
			}).format(change);
	const Icon = change >= 0 ? ArrowUpIcon : ArrowDownIcon;
	return (
		<span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
			<Icon aria-hidden="true" className="size-3" />
			{text}
		</span>
	);
}

function StatTile({
	metric,
	selected,
	bucketSeconds,
	hydrated,
	locale,
	onSelect,
}: {
	metric: OverviewMetric;
	selected: boolean;
	bucketSeconds: number;
	hydrated: boolean;
	locale: string;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			aria-label={m.overview_select_stat({ stat: STAT_LABEL[metric.stat]() })}
			onClick={onSelect}
			className={cn(
				"flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-ring focus-visible:outline-2 focus-visible:outline-ring",
				selected && "border-primary ring-1 ring-primary",
			)}
		>
			<div className="flex flex-col gap-1 px-4 pt-3">
				<div className="flex items-center justify-between gap-2">
					<span className="text-sm font-medium">
						{STAT_LABEL[metric.stat]()}
					</span>
					<Delta metric={metric} locale={locale} />
				</div>
				<span className="text-3xl font-semibold tracking-tight tabular-nums">
					{formatStat(metric.stat, metric.current, locale)}
				</span>
				<span className="text-xs text-muted-foreground">
					{metric.previous === null
						? m.overview_no_prior()
						: m.overview_vs_prior({
								value: formatStat(metric.stat, metric.previous, locale),
							})}
				</span>
			</div>
			<div className="mt-2 h-12">
				{hydrated && (
					<Sparkline points={metric.series} bucketSeconds={bucketSeconds} />
				)}
			</div>
		</button>
	);
}

/** A value with a thin proportional bar, so nodes compare at a glance. */
function Meter({ value, label }: { value: number | null; label: string }) {
	return (
		<span className="flex items-center justify-end gap-3">
			<span className="font-mono tabular-nums">{label}</span>
			<span
				aria-hidden="true"
				className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"
			>
				<span
					className="block h-full rounded-full"
					style={{
						width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%`,
						background: "var(--viz-1)",
					}}
				/>
			</span>
		</span>
	);
}

export function FleetOverview({
	userId,
	reference,
	initial,
}: {
	userId: string;
	reference: ProjectReference;
	initial: Overview;
}) {
	const hydrated = useHydrated();
	const locale = getLocale();
	const [range, setRange] = useState<OverviewRange>("1h");
	const [stat, setStat] = useState<OverviewStat>("cpu");
	const overview = useQuery<Overview>({
		queryKey: ["fleet-overview", userId, reference.projectId, range],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				(await getFleetOverview({
					data: { ...reference, range },
					signal,
				})) as OperationResult<Overview>,
			),
		initialData: range === "1h" ? initial : undefined,
		placeholderData: keepPreviousData,
		retry: false,
		staleTime: 30_000,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
	const data = overview.data;
	const selected =
		data?.metrics.find((metric) => metric.stat === stat) ?? data?.metrics[0];
	return (
		<section className="flex min-w-0 flex-col gap-5">
			<InsightsHeader tab="overview" reference={reference} />
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="flex items-end gap-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="overview-range" className="sr-only">
							{m.insight_range()}
						</Label>
						<NativeSelect
							id="overview-range"
							value={range}
							onChange={(event) =>
								setRange(event.target.value as OverviewRange)
							}
						>
							{RANGES.map((option) => (
								<NativeSelectOption key={option.value} value={option.value}>
									{option.label()}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					<Button
						variant="outline"
						size="icon"
						aria-label={m.overview_refresh()}
						title={m.overview_refresh()}
						disabled={!hydrated || overview.isFetching}
						onClick={() => void overview.refetch()}
					>
						<RefreshCwIcon
							aria-hidden="true"
							className={overview.isFetching ? "motion-safe:animate-spin" : ""}
						/>
					</Button>
				</div>
			</div>
			{overview.isError ? (
				<div
					role="alert"
					className="rounded-md border border-destructive/40 p-4 text-sm"
				>
					{m.overview_unavailable()}
				</div>
			) : !data?.available ? (
				<Empty className="border border-dashed bg-card">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<LayoutDashboardIcon aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>
							<h2>{m.overview_empty()}</h2>
						</EmptyTitle>
						<EmptyDescription>
							{m.overview_empty_description()}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div aria-busy={overview.isFetching} className="flex flex-col gap-5">
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
						{data.metrics.map((metric) => (
							<StatTile
								key={metric.stat}
								metric={metric}
								selected={metric.stat === selected?.stat}
								bucketSeconds={data.bucketSeconds}
								hydrated={hydrated}
								locale={locale}
								onSelect={() => setStat(metric.stat)}
							/>
						))}
					</div>
					{selected && (
						<div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
							<div className="flex flex-col gap-1">
								<h2 className="text-base font-semibold">
									{STAT_LABEL[selected.stat]()}
								</h2>
								<p className="text-sm text-muted-foreground">
									{STAT_DESCRIPTION[selected.stat]()}
								</p>
							</div>
							{hydrated ? (
								<TimeseriesChart
									label={m.overview_chart({
										stat: STAT_LABEL[selected.stat](),
									})}
									bucketSeconds={data.bucketSeconds}
									format={(value) => formatStat(selected.stat, value, locale)}
									series={[
										{
											key: "current",
											label: m.overview_this_period(),
											color: "var(--viz-1)",
											points: selected.series,
										},
										{
											key: "previous",
											label: m.overview_previous_period(),
											color: "var(--viz-1)",
											points: selected.previousSeries,
											comparison: true,
										},
									]}
								/>
							) : (
								<Skeleton className="h-72 w-full" />
							)}
						</div>
					)}
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1">
							<h2 className="text-base font-semibold">{m.overview_nodes()}</h2>
							<p className="text-sm text-muted-foreground">
								{m.overview_nodes_description()}
							</p>
						</div>
						<div className="rounded-md border bg-card">
							<Table aria-label={m.overview_nodes()}>
								<TableHeader>
									<TableRow>
										<TableHead>{m.overview_node()}</TableHead>
										<TableHead className="text-right">{m.stat_cpu()}</TableHead>
										<TableHead className="text-right">
											{m.stat_memory()}
										</TableHead>
										<TableHead className="text-right">
											{m.overview_memory_total()}
										</TableHead>
										<TableHead className="text-right">
											{m.stat_processes()}
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.nodes.map((node) => (
										<TableRow key={node.id}>
											<TableCell>
												<span className="font-medium" title={node.id}>
													{node.hostname ?? node.id}
												</span>
											</TableCell>
											<TableCell>
												<Meter
													value={node.cpu}
													label={formatStat("cpu", node.cpu, locale)}
												/>
											</TableCell>
											<TableCell>
												<Meter
													value={node.memory}
													label={formatStat("memory", node.memory, locale)}
												/>
											</TableCell>
											<TableCell className="text-right font-mono tabular-nums">
												{node.memoryTotal === null
													? "—"
													: formatMeasurement(node.memoryTotal, "By", locale)
															.text}
											</TableCell>
											<TableCell className="text-right font-mono tabular-nums">
												{formatStat("processes", node.processes, locale)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					</div>
				</div>
			)}
		</section>
	);
}
