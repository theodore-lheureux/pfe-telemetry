import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { TimeseriesChart } from "../../analytics/charts";
import { formatValue } from "../../analytics/insight/labels";
import { stats } from "../../analytics/insight/series-view";
import { Badge } from "../../components/ui/badge";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "../../components/ui/card";
import { IconEmptyState } from "../../components/workspace";
import { formatElapsed } from "./elapsed";
import type {
	ComparedMeasurement,
	MeasurementName,
	MeasurementStatus,
	PlannedMeasurement,
} from "./measurements";
import { SIDE_COLORS, SideSwatch } from "./side-swatch";

const TITLES: Record<
	MeasurementName,
	{ title: () => string; description: () => string }
> = {
	cpu: {
		title: m.execution_compare_cpu,
		description: m.execution_compare_cpu_description,
	},
	memory: {
		title: m.execution_compare_memory,
		description: m.execution_compare_memory_description,
	},
	io: {
		title: m.execution_compare_io,
		description: m.execution_compare_io_description,
	},
};

const STATUS_LABEL: Record<
	Exclude<MeasurementStatus, "comparable">,
	() => string
> = {
	incomparable: m.execution_compare_incomparable,
	unavailable: m.execution_compare_unavailable,
};

/** Why a measurement shows nothing: the project lacks the metric, or the executions do. */
function unavailableDescription(planned: PlannedMeasurement) {
	return planned.definition
		? m.execution_compare_unavailable_executions()
		: m.execution_compare_unavailable_project();
}

/** One measurement of both executions over elapsed time, with each one's average and peak. */
export function MeasurementCard({
	planned,
	measurement,
	names,
	bucketSeconds,
}: {
	planned: PlannedMeasurement;
	measurement: ComparedMeasurement;
	names: [string, string];
	bucketSeconds: number;
}) {
	const { title, description } = TITLES[planned.name];
	const locale = getLocale();
	const status: MeasurementStatus = planned.definition
		? measurement.status
		: "unavailable";
	const format = (value: number | null) =>
		formatValue(
			value,
			{ unit: "auto" },
			planned.definition && planned.calculation
				? { unit: planned.definition.unit, calculation: planned.calculation }
				: null,
			locale,
		);
	const recorded = measurement.series.flatMap((series, side) =>
		series.recorded ? [{ series, side }] : [],
	);
	const missing = measurement.series.findIndex((series) => !series.recorded);
	return (
		<Card data-measurement={planned.name} data-status={status}>
			<CardHeader>
				<CardTitle>
					<h3 className="text-balance">{title()}</h3>
				</CardTitle>
				<CardDescription className="text-pretty">
					{description()}
				</CardDescription>
				{status !== "comparable" && (
					<CardAction>
						<Badge variant="outline">{STATUS_LABEL[status]()}</Badge>
					</CardAction>
				)}
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{status === "unavailable" ? (
					<IconEmptyState
						icon={<ChartNoAxesColumnIcon aria-hidden="true" />}
						title={m.execution_compare_no_measurements()}
						description={unavailableDescription(planned)}
						heading="h3"
						className="h-56"
					/>
				) : (
					<TimeseriesChart
						label={m.execution_compare_chart_label({ measurement: title() })}
						series={recorded.map(({ series, side }) => ({
							key: `side${side}`,
							label: names[side],
							color: SIDE_COLORS[side],
							points: series.points,
						}))}
						bucketSeconds={bucketSeconds}
						format={format}
						type="line"
						elapsed={formatElapsed}
						xLabel={m.execution_compare_elapsed()}
						legend={false}
						height="h-56"
						gapLabel={() => m.insight_gap_unknown()}
					/>
				)}
				{status === "incomparable" && missing >= 0 && (
					<p className="text-sm text-muted-foreground text-pretty">
						{m.execution_compare_incomparable_description({
							execution: names[missing],
						})}
					</p>
				)}
			</CardContent>
			{status !== "unavailable" && (
				<CardFooter>
					<dl className="grid w-full gap-2 text-sm sm:grid-cols-2">
						{measurement.series.map((series, side) => {
							const summary = stats(series);
							return (
								<div
									key={series.execution}
									className="flex min-w-0 flex-col gap-0.5"
								>
									<dt className="flex min-w-0 items-center gap-2 text-muted-foreground">
										<SideSwatch side={side} />
										<span className="truncate">{names[side]}</span>
									</dt>
									<dd className="tabular-nums">
										{series.recorded
											? m.execution_compare_summary({
													average: format(summary.average),
													peak: format(summary.max),
												})
											: m.execution_compare_not_recorded()}
									</dd>
								</div>
							);
						})}
					</dl>
				</CardFooter>
			)}
		</Card>
	);
}
