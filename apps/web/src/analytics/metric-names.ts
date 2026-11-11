import { m } from "@recount/i18n/messages";

// Friendly names for the metrics Recount's collector sends. Other metrics, including
// any sent by standard OpenTelemetry exporters, keep their technical names.
const METRICS: Record<
	string,
	{ name: () => string; description: () => string }
> = {
	"recount.node.cpu.time": {
		name: m.metric_node_cpu_time,
		description: m.metric_node_cpu_time_description,
	},
	"recount.node.memory.total": {
		name: m.metric_node_memory_total,
		description: m.metric_node_memory_total_description,
	},
	"recount.node.memory.available": {
		name: m.metric_node_memory_available,
		description: m.metric_node_memory_available_description,
	},
	"system.disk.io": {
		name: m.metric_disk_io,
		description: m.metric_disk_io_description,
	},
	"process.cpu.time": {
		name: m.metric_process_cpu_time,
		description: m.metric_process_cpu_time_description,
	},
	"recount.process.memory.rss": {
		name: m.metric_process_memory_rss,
		description: m.metric_process_memory_rss_description,
	},
	"process.disk.io": {
		name: m.metric_process_disk_io,
		description: m.metric_process_disk_io_description,
	},
	"recount.collection.discovered.processes": {
		name: m.metric_processes_discovered,
		description: m.metric_processes_discovered_description,
	},
	"recount.collection.discarded.processes": {
		name: m.metric_processes_discarded,
		description: m.metric_processes_discarded_description,
	},
	"recount.collection.dropped.points": {
		name: m.metric_dropped_points,
		description: m.metric_dropped_points_description,
	},
	"recount.collection.scan.duration": {
		name: m.metric_scan_duration,
		description: m.metric_scan_duration_description,
	},
	"recount.collection.read.status": {
		name: m.metric_read_status,
		description: m.metric_read_status_description,
	},
	"recount.collection.discovery.status": {
		name: m.metric_discovery_status,
		description: m.metric_discovery_status_description,
	},
	"recount.clock.status": {
		name: m.metric_clock_status,
		description: m.metric_clock_status_description,
	},
};

const ATTRIBUTES: Record<string, () => string> = {
	"cpu.mode": m.attribute_cpu_mode,
	"disk.io.direction": m.attribute_disk_direction,
	"system.device": m.attribute_device,
	reason: m.attribute_reason,
	"recount.metric.name": m.attribute_measured_metric,
	"host.name": m.attribute_host_name,
	"host.id": m.attribute_host_id,
	"os.type": m.attribute_os_type,
	"process.pid": m.attribute_process_pid,
	"process.parent_pid": m.attribute_parent_pid,
	"recount.collection.scope": m.attribute_collection_scope,
	"recount.collection.source": m.attribute_collection_source,
	"recount.collection.visibility": m.attribute_visibility,
};

/** A readable metric name; unknown metrics show their technical name. */
export function metricLabel(name: string) {
	return METRICS[name]?.name() ?? name;
}

export function metricDescription(name: string) {
	return METRICS[name]?.description() ?? null;
}

/** Whether the metric has a friendly name distinct from its technical one. */
export function isNamedMetric(name: string) {
	return name in METRICS;
}

export function attributeLabel(key: string) {
	return ATTRIBUTES[key]?.() ?? key;
}

/** A readable unit: common UCUM codes named, `{annotation}` units shown without braces. */
export function unitLabel(unit: string) {
	if (!unit || unit === "1") return "";
	if (unit === "By") return m.unit_bytes();
	if (unit === "s") return m.unit_seconds();
	return /^\{(.+)\}$/.exec(unit)?.[1] ?? unit;
}
