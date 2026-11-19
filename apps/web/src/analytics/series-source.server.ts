/** Project-scoped series first, then indexed points with the small set on the right. */
export function seriesPointSource(
	seriesWhere: string,
	pointWhere: string,
	dimensions = "s.* EXCEPT (project_id, series_id, metric_name)",
	pointMetric = "",
	seriesExpressions: string[] = [],
) {
	return `WITH selected_series AS (
  SELECT *${seriesExpressions.length ? `, ${seriesExpressions.join(", ")}` : ""} FROM metric_series FINAL
  WHERE project_id = {project:String}${seriesWhere}
)
SELECT p.*${dimensions ? `, ${dimensions}` : ""}
FROM (
  SELECT * FROM metric_points FINAL
  WHERE project_id = {project:String} AND series_id IN (SELECT series_id FROM selected_series)
    ${pointWhere}
    ${pointMetric ? `AND metric_name IN (SELECT metric_name FROM selected_series) ${pointMetric}` : ""}
) AS p
INNER JOIN selected_series AS s USING (series_id)`;
}

export const SERIES_WINDOW = ` AND last_seen_unix_nano >= {from:UInt64} AND first_seen_unix_nano < {to:UInt64}`;
export const POINT_WINDOW = `AND event_day >= {firstDay:UInt32} AND event_day <= {lastDay:UInt32}
    AND time_unix_nano >= {from:UInt64} AND time_unix_nano < {to:UInt64}`;
