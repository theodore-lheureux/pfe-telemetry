WITH memberships AS (
    SELECT node_id, assumeNotNull(process_resource_id) AS resource,
           first_seen_unix_nano AS start,
           ifNull(ended_unix_nano, last_seen_unix_nano + 1) AS end
    FROM telemetry.execution_participants FINAL
    WHERE project_id = {project:String} AND execution_key = {execution:String}
      AND kind = 2 AND retracted = 0 AND process_resource_id IS NOT NULL
)
SELECT resource_kind, resource_id, metric_name, time_unix_nano,
       int_value, double_value, scope_name, scope_version,
       arrayMap(a -> (a.path, a.string_value), point_attributes) AS attributes,
       arrayMap(a -> (a.path, a.string_value), resource_attributes) AS resource_attributes,
       resource_kind = 4 AND arrayExists(
           m -> m.1 = source_id AND m.2 = resource_id
                AND time_unix_nano >= m.3 AND time_unix_nano < m.4,
           (SELECT groupArray((node_id, resource, start, end)) FROM memberships)
       ) AS attributed
FROM telemetry.metric_points
WHERE project_id = {project:String} AND source_id = {node:String}
  AND (startsWith(metric_name, 'recount.gpu.')
       OR startsWith(metric_name, 'recount.process.gpu.')
       OR (resource_kind = 3 AND metric_name = 'recount.collection.read.status'))
ORDER BY time_unix_nano, resource_id, metric_name
FORMAT JSONEachRow
