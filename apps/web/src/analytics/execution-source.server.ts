/**
 * One joined row per point resource. Intervals are tested as a set, never joined
 * individually: repeated and overlapping facts cannot multiply measurements.
 * Callers supply project/time-predicated points and enforce their usual read caps.
 */
export function executionPointSource(points: string) {
	return `(SELECT points.*, arraySort(arrayDistinct(arrayMap(m -> m.1,
    arrayFilter(m -> resource_kind = 4 AND time_unix_nano >= m.2 AND
      if(m.4 = 0, time_unix_nano <= m.3, time_unix_nano < m.4), memberships)))) AS execution_keys
  FROM (${points}) AS points
  LEFT JOIN (
    SELECT node_id AS membership_node, assumeNotNull(process_resource_id) AS membership_resource,
      groupArray(tuple(execution_key, first_seen_unix_nano, last_seen_unix_nano,
        ifNull(ended_unix_nano, toUInt64(0)))) AS memberships
    FROM (
      SELECT * FROM execution_participants FINAL WHERE project_id = {project:String}
    )
    WHERE NOT retracted AND kind = 2 AND process_resource_id IS NOT NULL
      AND first_seen_unix_nano < {to:UInt64}
      AND if(isNull(ended_unix_nano), last_seen_unix_nano >= {from:UInt64}, ended_unix_nano > {from:UInt64})
    GROUP BY membership_node, membership_resource
  ) AS membership_sets
  ON points.source_id = membership_node AND points.resource_id = membership_resource)`;
}
