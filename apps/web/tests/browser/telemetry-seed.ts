import type { ClickHouseClient } from "@clickhouse/client";

/** Copy recent measurements and their definitions into an owned browser-test project. */
export async function seedRecentTelemetry(
	client: ClickHouseClient,
	project: string,
	metrics: string[],
	minutes: number,
	limit: number,
	includePrevious = false,
) {
	const shared = `WHERE metric_name IN {metrics:Array(String)}
		AND last_seen_unix_milli > toUInt64(now() - toIntervalMinute({minutes:UInt32})) * 1000
		AND project_id != {project:String}`;
	const query_params = { project, metrics, minutes, limit };
	const shift = includePrevious ? 3_600_000 : 0;
	// Test-only IDs isolate definitions from different source projects without
	// needing to serialize copied dimensions back to the normalizer.
	const key = "cityHash64(project_id, series_id, {project:String})";
	await client.command({
		query: `INSERT INTO telemetry.metric_series
		SELECT * REPLACE ({project:String} AS project_id, ${key} AS series_id,
			cityHash64(project_id, logical_series_id, {project:String}) AS logical_series_id,
			if(first_seen_unix_milli >= ${shift}, first_seen_unix_milli - ${shift}, 0) AS first_seen_unix_milli)
		FROM telemetry.metric_series FINAL ${shared}`,
		query_params,
	});
	await client.command({
		query: `INSERT INTO telemetry.metric_points
		SELECT * REPLACE ({project:String} AS project_id, ${key} AS series_id)
		FROM telemetry.metric_points
		WHERE (project_id, series_id) IN (
			SELECT project_id, series_id FROM telemetry.metric_series FINAL ${shared}
		)
			AND event_day >= intDiv(toUnixTimestamp(now() - toIntervalMinute({minutes:UInt32})), 86400)
			AND time_unix_milli > toUInt64(now() - toIntervalMinute({minutes:UInt32})) * 1000
		LIMIT {limit:UInt32}`,
		query_params,
	});
	if (includePrevious)
		await client.command({
			query: `INSERT INTO telemetry.metric_points
			SELECT * REPLACE (
				time_unix_milli - ${shift} AS time_unix_milli,
				toUInt32(intDiv(time_unix_milli - ${shift}, 86400000)) AS event_day)
			FROM telemetry.metric_points WHERE project_id = {project:String}`,
			query_params,
		});
}

export async function clearTelemetry(
	client: ClickHouseClient,
	project: string,
) {
	for (const table of [
		"metric_points",
		"metric_series",
		"activity_series",
		"deliveries",
	])
		await client.command({
			query: `ALTER TABLE telemetry.${table} DELETE WHERE project_id = {project:String} SETTINGS mutations_sync = 1`,
			query_params: { project },
		});
}
