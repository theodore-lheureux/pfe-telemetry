// LIMIT BY can keep an older receipt. FINAL selects the winning version;
// duplicate timestamps map to the same event-day partition.
export const POINT_FINAL_SETTINGS = {
	do_not_merge_across_partitions_select_final: 1,
} as const;

export function streamEvidenceSource(points: string, streamFilter = "") {
	return `(SELECT p.*, e.resource_continuity, e.point_continuity, e.evidence_present
FROM (${points}) AS p
LEFT JOIN (
  SELECT stream_id, resource_continuity, point_continuity, toUInt8(1) AS evidence_present
  FROM metric_streams FINAL WHERE project_id = {project:String}${streamFilter}
) AS e USING (stream_id))`;
}

/** Project-scoped series first, then indexed points with the small set on the right. */
export function seriesPointSource(
	seriesWhere: string,
	pointWhere: string,
	dimensions = "s.* EXCEPT (project_id, series_id, metric_name, host_id), nullIf(s.host_id,'') AS host_id",
	pointMetric = "",
	seriesExpressions: string[] = [],
) {
	return `WITH selected_series AS (
  SELECT *${seriesExpressions.length ? `, ${seriesExpressions.join(", ")}` : ""} FROM metric_series FINAL
  WHERE project_id = {project:String}${seriesWhere}
)
SELECT p.*${dimensions ? `, ${dimensions}` : ""}
FROM (
  SELECT * REPLACE (if(value_kind=1,int_value,NULL) AS int_value,
    if(value_kind=2,double_value,NULL) AS double_value) FROM metric_points FINAL
  WHERE project_id = {project:String} AND series_id IN (SELECT series_id FROM selected_series)
    ${pointWhere}
    ${pointMetric ? `AND metric_name IN (SELECT metric_name FROM selected_series) ${pointMetric}` : ""}
) AS p
INNER JOIN selected_series AS s USING (series_id)`;
}

// Matches MAX_SERIES_RESEND_SECONDS. Only widen metadata pruning.
export function seriesLastSeen(time: string) {
	return `last_seen_unix_nano >= (${time} - least(${time}, toUInt64(60000000000)))`;
}

export const SERIES_WINDOW = ` AND ${seriesLastSeen("{from:UInt64}")} AND first_seen_unix_nano < {to:UInt64}`;
export const POINT_WINDOW = `AND event_day >= {firstDay:UInt32} AND event_day <= {lastDay:UInt32}
    AND time_unix_nano >= {from:UInt64} AND time_unix_nano < {to:UInt64}`;
