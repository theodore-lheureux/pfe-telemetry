WITH memberships AS (
    SELECT node_id, assumeNotNull(process_resource_id) AS resource,
           first_seen_unix_nano AS start,
           ifNull(ended_unix_nano, last_seen_unix_nano + 1) AS end
    FROM telemetry.execution_participants FINAL
    WHERE project_id = {project:String} AND execution_key = {execution:String}
      AND kind = 2 AND retracted = 0 AND process_resource_id IS NOT NULL
)
SELECT project_id, source_id, resource_id, metric_name, unit,
       hex(sample_id) AS sample_id, series_id, time_unix_nano,
       start_time_unix_nano, int_value, double_value, temporality,
       monotonic, scope_name, scope_version,
       arrayMap(a -> (a.path, a.string_value), point_attributes) AS attributes
FROM telemetry.metric_points
WHERE project_id = {project:String}
  AND time_unix_nano >= {start:UInt64} AND time_unix_nano <= {end:UInt64}
  AND (source_id, resource_id) IN (SELECT node_id, resource FROM memberships)
  AND arrayExists(
      m -> m.1 = source_id AND m.2 = resource_id
           AND time_unix_nano >= m.3 AND time_unix_nano < m.4,
      (SELECT groupArray((node_id, resource, start, end)) FROM memberships)
  )
ORDER BY source_id, resource_id, metric_name, series_id, time_unix_nano
FORMAT JSONEachRow
