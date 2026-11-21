import type { getDatabase } from "../db/client.server";
import { getTelemetryClient } from "../executions/telemetry.server";
import { InputError } from "../lib/input-error";
import { type Actor, requireProject } from "../organizations/access.server";
import { parseProjectReference } from "../organizations/validation";
import { withAnalyticsSlot } from "./capacity.server";
import type { HistogramWindow } from "./histograms";
import {
	POINT_FINAL_SETTINGS,
	POINT_WINDOW,
	SERIES_WINDOW,
	seriesPointSource,
} from "./series-source.server";
import { parseMetricName } from "./validation";

const DAY = 86_400_000;
const COLUMNS = 48;
const LIMIT = 192;

export function parseHistogramInput(value: unknown) {
	const reference = parseProjectReference(value);
	const { metric, unit, from, to } = value as Record<string, unknown>;
	if (
		typeof unit !== "string" ||
		unit.length > 63 ||
		!(from instanceof Date) ||
		!(to instanceof Date) ||
		!Number.isFinite(from.getTime()) ||
		!Number.isFinite(to.getTime()) ||
		from.getTime() < 0 ||
		to <= from ||
		to.getTime() - from.getTime() > 366 * DAY
	)
		throw new InputError("INVALID_QUERY", "Invalid histogram window");
	return { ...reference, metric: parseMetricName(metric), unit, from, to };
}

const source = seriesPointSource(
	`${SERIES_WINDOW} AND metric_name = {metric:String} AND metric_kind = 3
	AND temporality = 1 AND unit = {unit:String}`,
	POINT_WINDOW,
	"",
	"AND metric_name = {metric:String}",
);

export async function readHistogram(
	database: ReturnType<typeof getDatabase>,
	actor: Actor,
	input: ReturnType<typeof parseHistogramInput>,
	signal: AbortSignal,
) {
	await requireProject(database, actor, input);
	const from = input.from.getTime();
	const to = input.to.getTime();
	const step = Math.ceil((to - from) / COLUMNS);
	const rows = await withAnalyticsSlot(
		database,
		input.organizationId,
		signal,
		async () => {
			const result = await getTelemetryClient().query({
				query: `SELECT toString({from:UInt64} + intDiv(time_unix_milli - {from:UInt64}, {step:UInt64}) * {step:UInt64}) AS bucket,
	explicit_bounds AS bounds, arrayMap(x -> toString(x), sumForEach(arrayMap(x -> toUInt128(x), bucket_counts))) AS counts,
	toString(sum(toUInt128(count))) AS count,
	if(countIf(NOT bitTest(statistics_present, 1)) = 0, sum(\`sum\`) / nullIf(sum(toFloat64(count)), 0), NULL) AS mean,
	if(countIf(NOT bitTest(statistics_present, 2)) = 0, min(\`min\`), NULL) AS min,
	if(countIf(NOT bitTest(statistics_present, 3)) = 0, max(\`max\`), NULL) AS max
	FROM (${source})
	WHERE bitAnd(flags, 1) = 0 AND bitTest(statistics_present, 0) AND length(explicit_bounds) <= 64
	AND length(bucket_counts) = length(explicit_bounds) + 1
	GROUP BY bucket, bounds ORDER BY bucket, bounds LIMIT ${LIMIT + 1}`,
				query_params: {
					project: input.projectId,
					metric: input.metric,
					unit: input.unit,
					from,
					to,
					step,
					firstDay: Math.floor(from / DAY),
					lastDay: Math.floor((to - 1) / DAY),
				},
				format: "JSONEachRow",
				abort_signal: signal,
				clickhouse_settings: {
					...POINT_FINAL_SETTINGS,
					prefer_column_name_to_alias: 1,
					max_execution_time: 6,
					max_rows_to_read: "20000000",
					max_bytes_to_read: "2147483648",
					max_rows_to_group_by: "512",
				},
			});
			return result.json<HistogramWindow>();
		},
	);
	return { rows: rows.slice(0, LIMIT), limited: rows.length > LIMIT, step };
}
