import type { ClickHouseClient } from "@clickhouse/client";
import {
	type AnalyticsQuery,
	type Filter,
	INTERVALS,
	type Interval,
	MAX_RANGE_SECONDS,
	type Measure,
	type QueryResult,
} from "../analytics/contracts";
import { metricDefinitions } from "../analytics/discovery.server";
import { analyticsError, runQuery } from "../analytics/runner.server";
import { parseQuery } from "../analytics/validation";
import { OperationError } from "../lib/operation-error";
import type { readExecutionSpans } from "./overlap-reads.server";
import {
	type ExecutionLoad,
	LOAD_METRICS,
	LOAD_NODE_LIMIT,
	LOAD_SHARES,
	type LoadMetric,
	type LoadShare,
} from "./overlaps";
import { getTelemetryClient, readDeadline } from "./telemetry.server";

type Spans = Awaited<ReturnType<typeof readExecutionSpans>>;

/** A small chart's buckets: the shortest interval giving at most this many. */
const LOAD_BUCKETS = 120;

const measureName = (metric: LoadMetric, share: LoadShare) =>
	`${metric}_${share}`;

function shareFilters(share: LoadShare, executionKey: string): Filter[] {
	if (share === "execution")
		return [{ field: "execution", op: "eq", values: [executionKey] }];
	if (share === "others")
		return [
			{ field: "execution", op: "exists" },
			{ field: "execution", op: "neq", values: [executionKey] },
		];
	return [{ field: "execution", op: "not_exists" }];
}

/**
 * The selected execution's active time in whole buckets of the shortest interval that
 * keeps the chart small, limited to the most recent maximum analytics range. Partial
 * buckets would divide a counter's increase by only part of the time it accrued over.
 */
export function loadRange(spans: Spans) {
	// Span ends are truncated to milliseconds; the range includes the last one.
	const end = Math.max(...spans.map((span) => span.to.getTime())) + 1;
	const start = Math.max(
		Math.min(...spans.map((span) => span.from.getTime())),
		end - MAX_RANGE_SECONDS * 1000,
	);
	const interval =
		(Object.keys(INTERVALS) as Interval[]).find(
			(entry) =>
				Math.ceil((end - start) / 1000 / INTERVALS[entry]) <= LOAD_BUCKETS,
		) ?? "1d";
	const step = INTERVALS[interval] * 1000;
	const to = Math.ceil(end / step) * step;
	const from = Math.max(
		Math.floor(start / step) * step,
		to - Math.floor((MAX_RANGE_SECONDS * 1000) / step) * step,
	);
	return { from: new Date(from), to: new Date(to), interval };
}

/** The validated analytics query behind the load split of the available metrics. */
export function loadQuery(
	executionKey: string,
	spans: Spans,
	metrics: LoadMetric[],
): AnalyticsQuery {
	const range = loadRange(spans);
	const measures: Measure[] = metrics.flatMap((metric) =>
		LOAD_SHARES.map((share) => ({
			name: measureName(metric, share),
			...LOAD_METRICS[metric],
			filters: shareFilters(share, executionKey),
		})),
	);
	return parseQuery({
		shape: "timeseries",
		range: { from: range.from.toISOString(), to: range.to.toISOString() },
		interval: range.interval,
		measures,
		filters: [
			{ field: "node", op: "in", values: spans.map((span) => span.nodeId) },
		],
	});
}

async function availableMetrics(
	connection: ClickHouseClient,
	projectId: string,
	signal?: AbortSignal,
) {
	try {
		return await metricDefinitions(
			connection,
			projectId,
			Object.values(LOAD_METRICS).map((entry) => entry.metric),
			readDeadline(signal),
		);
	} catch (error) {
		return analyticsError(error, signal);
	}
}

/**
 * How the selected execution's nodes were loaded while it ran: by its own processes,
 * by the project's other executions and by the project's unlabelled processes.
 */
export async function readExecutionLoad(
	projectId: string,
	executionKey: string,
	spans: Spans,
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
): Promise<ExecutionLoad> {
	if (spans.length > LOAD_NODE_LIMIT)
		throw new OperationError("CAPACITY", "Too many nodes for the load split");
	const definitions = await availableMetrics(connection, projectId, signal);
	const available = (Object.keys(LOAD_METRICS) as LoadMetric[]).filter(
		(metric) => definitions.has(LOAD_METRICS[metric].metric),
	);
	const range = loadRange(spans);
	const result: Pick<QueryResult, "series"> = available.length
		? await runQuery(
				projectId,
				loadQuery(executionKey, spans, available),
				signal,
				connection,
				{ definitions, coverage: false },
			)
		: { series: [] };
	const metric = (name: LoadMetric) => {
		const definition = definitions.get(LOAD_METRICS[name].metric);
		if (!definition) return null;
		return {
			unit: definition.unit,
			calculation: LOAD_METRICS[name].calculation,
			series: LOAD_SHARES.map((share) => ({
				share,
				points: (
					result.series.find(
						(series) => series.measure === measureName(name, share),
					)?.points ?? []
				).flatMap((point) =>
					point.bucketMs === null
						? []
						: [{ bucketMs: point.bucketMs, value: point.value }],
				),
			})),
		};
	};
	return {
		from: range.from,
		to: range.to,
		bucketSeconds: INTERVALS[range.interval],
		nodeCount: spans.length,
		metrics: { cpu: metric("cpu"), memory: metric("memory") },
	};
}
