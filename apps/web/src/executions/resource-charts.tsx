import { formatDate, formatSeconds } from "@pfe/i18n";
import { m } from "@pfe/i18n/messages";
import { getLocale } from "@pfe/i18n/runtime";
import { useId } from "react";
import type { TelemetryResult, TelemetrySeries } from "./contracts";

function label(series: TelemetrySeries) {
	return series.metric === "pfe.node.cpu.time"
		? m.node_cumulative_cpu_time()
		: series.metric === "pfe.node.memory.total"
			? m.node_total_memory()
			: m.node_available_memory();
}
function plotValue(point: TelemetrySeries["points"][number]) {
	if (point.integer !== null) {
		const value = BigInt(point.integer);
		return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
			value >= BigInt(Number.MIN_SAFE_INTEGER)
			? Number(value)
			: null;
	}
	return point.double;
}

export function formatSample(value: number) {
	const decimal =
		new Intl.NumberFormat(getLocale())
			.formatToParts(1.1)
			.find((part) => part.type === "decimal")?.value ?? ".";
	return value.toString().replace(".", decimal);
}
function Series({
	series,
	result,
}: {
	series: TelemetrySeries;
	result: TelemetryResult;
}) {
	const id = useId();
	const values = series.points
		.map(plotValue)
		.filter((value): value is number => value !== null);
	const min = values.length ? Math.min(...values) : 0;
	const max = values.length ? Math.max(...values) : 0;
	const duration = result.to.getTime() - result.from.getTime();
	const title = `${label(series)} · ${series.hostId ?? m.unidentified_host()}${series.cpuMode ? ` · ${series.cpuMode}` : ""} · ${m.collection_profile({ profile: series.profile })} · ${series.id.slice(-8)}`;
	return (
		<section className="space-y-3 rounded-xl border p-4">
			<h3 className="font-semibold">
				{title} ({series.unit})
			</h3>
			<svg
				viewBox="0 0 600 160"
				role="img"
				aria-labelledby={`${id}-title ${id}-description`}
				className="h-40 w-full"
			>
				<title id={`${id}-title`}>{title}</title>
				<desc id={`${id}-description`}>
					{m.node_context_not_execution_workload_consumption_last_sample()}
				</desc>
				{series.points.map((point) => {
					const value = plotValue(point);
					return value === null ? null : (
						<circle
							key={point.bucketMs}
							cx={
								10 + ((point.bucketMs - result.from.getTime()) / duration) * 580
							}
							cy={max === min ? 80 : 150 - ((value - min) / (max - min)) * 140}
							r={3}
							fill="currentColor"
						/>
					);
				})}
			</svg>
			<p className="text-xs text-muted-foreground">{m.chart_exact_values()}</p>
			<section
				aria-label={m.chart_values({ metric: label(series) })}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard access to overflowing values.
				tabIndex={0}
				className="max-h-64 overflow-auto"
			>
				<table className="w-full text-left text-sm">
					<caption>
						{m.chart_caption({ label: title, unit: series.unit })}
					</caption>
					<thead>
						<tr>
							<th>{m.bucket_start_utc()}</th>
							<th>{m.sample_nanoseconds()}</th>
							<th>{series.unit}</th>
						</tr>
					</thead>
					<tbody>
						{series.points.map((point) => (
							<tr key={point.bucketMs}>
								<td>{formatDate(point.bucketMs)}</td>
								<td className="font-mono text-xs">{point.timeNs}</td>
								<td>
									{point.integer !== null
										? new Intl.NumberFormat(getLocale()).format(
												BigInt(point.integer),
											)
										: point.double !== null
											? formatSample(point.double)
											: m.no_recorded_value()}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</section>
	);
}
export function ResourceCharts({ result }: { result: TelemetryResult }) {
	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				{m.chart_context({ duration: formatSeconds(result.bucketMs / 1000) })}
			</p>
			{result.series.length ? (
				result.series.map((series) => (
					<Series key={series.id} series={series} result={result} />
				))
			) : (
				<p role="status">{m.no_node_cpu_or_memory_samples_match_this()}</p>
			)}
		</div>
	);
}
