import type { ClickHouseClient } from "@clickhouse/client";
import {
	type AnalyticsQuery,
	INTERVALS,
	MAX_RANGE_SECONDS,
	MAX_SERIES,
	type Measure,
	type QueryResult,
} from "../analytics/contracts";
import { metricDefinitions } from "../analytics/discovery.server";
import { autoInterval } from "../analytics/intervals";
import { analyticsError, runQuery } from "../analytics/runner.server";
import { ALLOWED_CALCULATIONS } from "../analytics/validation";
import type { ExecutionFact } from "./contracts";
import { EXECUTION_MEASURES } from "./measurements";
import { getTelemetryClient } from "./telemetry.server";
import { executionSpan, type Span } from "./timeline";

/**
 * The query behind an execution's charts, over its observed span (the latest 30 days of
 * it at most) by node. Open memberships include their last observation, so the range
 * runs past it. The range covers whole buckets: a rate divides by the part of a bucket
 * the range covers, so a cut bucket would overstate it.
 */
export function executionMeasurementQuery(
	executionKey: string,
	span: Span,
	measures: Measure[],
	node?: string,
): AnalyticsQuery {
	const end = span.to + 1;
	const start = Math.max(span.from, end - MAX_RANGE_SECONDS * 1000);
	const interval = autoInterval(new Date(start), new Date(end));
	const step = INTERVALS[interval] * 1000;
	const from = Math.floor(start / step) * step;
	const to = Math.max(Math.ceil(end / step) * step, from + step);
	return {
		shape: "timeseries",
		range: {
			from: new Date(
				Math.max(from, to - MAX_RANGE_SECONDS * 1000),
			).toISOString(),
			to: new Date(to).toISOString(),
		},
		interval,
		measures,
		filters: [
			{ field: "execution", op: "eq", values: [executionKey] },
			...(node ? [{ field: "node", op: "eq" as const, values: [node] }] : []),
		],
		groupBy: ["node"],
		limit: MAX_SERIES,
		other: false,
	};
}

/** The execution's process measurements, or null when the project has none of them. */
export async function readExecutionMeasurements(
	projectId: string,
	executionKey: string,
	facts: ExecutionFact[],
	node: string | undefined,
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
): Promise<QueryResult | null> {
	const span = executionSpan(facts);
	if (!span) return null;
	let definitions: Awaited<ReturnType<typeof metricDefinitions>>;
	try {
		definitions = await metricDefinitions(
			connection,
			projectId,
			EXECUTION_MEASURES.map((measure) => measure.metric),
			signal
				? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
				: AbortSignal.timeout(10_000),
		);
	} catch (error) {
		return analyticsError(error, signal);
	}
	const measures = EXECUTION_MEASURES.filter((measure) => {
		const definition = definitions.get(measure.metric);
		return (
			definition !== undefined &&
			ALLOWED_CALCULATIONS[definition.behavior].includes(measure.calculation)
		);
	});
	if (!measures.length) return null;
	return runQuery(
		projectId,
		executionMeasurementQuery(executionKey, span, measures, node),
		signal,
		connection,
		{ definitions },
	);
}
