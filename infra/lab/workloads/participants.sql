SELECT project_id, node_id, host_id, boot_id, execution_key,
       participant_id, fact_id, revision, kind, process_resource_id,
       process_namespace_id, process_pid, process_start_time_ticks,
       origin, owner_uid, first_seen_unix_nano, last_seen_unix_nano,
       ended_unix_nano, retracted, execution_name, workload_version,
       parameters, environment_variable, record_id, received_unix_nano
FROM telemetry.execution_participants FINAL
WHERE project_id = {project:String} AND execution_key = {execution:String}
ORDER BY node_id, kind, fact_id
FORMAT JSONEachRow
