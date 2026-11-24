import { m } from "@recount/i18n/messages";

// Friendly names for the metrics Recount's collector sends. Other metrics, including
// any sent by standard OpenTelemetry exporters, keep their technical names.
const METRICS: Record<
	string,
	{
		name: () => string;
		description: () => string;
		/** Per-process detail the collector caps per node; its coverage is reported. */
		detail?: boolean;
	}
> = {
	"recount.node.process.cpu.utilization.distribution": {
		name: m.metric_hist_process_cpu,
		description: m.metric_hist_process_cpu_description,
	},
	"recount.node.process.memory.rss.distribution": {
		name: m.metric_hist_process_memory,
		description: m.metric_hist_process_description,
	},
	"recount.node.process.disk.io.rate.distribution": {
		name: m.metric_hist_process_disk,
		description: m.metric_hist_process_description,
	},
	"recount.node.gpu.utilization.distribution": {
		name: m.metric_hist_gpu_utilization,
		description: m.metric_hist_gpu_utilization,
	},
	"recount.node.gpu.memory.used.distribution": {
		name: m.metric_hist_gpu_memory,
		description: m.metric_hist_gpu_memory,
	},
	"recount.node.gpu.power.distribution": {
		name: m.metric_hist_gpu_power,
		description: m.metric_hist_gpu_power,
	},
	"recount.node.tcp.rtt.distribution": {
		name: m.metric_hist_tcp_rtt,
		description: m.metric_hist_tcp_rtt,
	},
	"recount.process.gpu.memory.used": {
		name: m.gpu_process_memory,
		description: m.gpu_process_memory_description,
	},
	"recount.process.gpu.utilization": {
		name: m.gpu_process_utilization,
		description: m.gpu_process_utilization_description,
	},
	"recount.process.gpu.memory.activity": {
		name: m.gpu_process_memory_activity,
		description: m.gpu_process_memory_activity_description,
	},
	"recount.gpu.process.discovery.status": {
		name: m.gpu_process_discovery,
		description: m.gpu_process_discovery_description,
	},
	"recount.gpu.engine.activity": {
		name: m.gpu_engine,
		description: m.gpu_engine_description,
	},
	"recount.gpu.sm.activity": {
		name: m.gpu_sm_activity,
		description: m.gpu_sm_activity_description,
	},
	"recount.gpu.sm.occupancy": {
		name: m.gpu_sm_occupancy,
		description: m.gpu_sm_occupancy_description,
	},
	"recount.gpu.pipe.activity": {
		name: m.gpu_pipe_activity,
		description: m.gpu_pipe_activity_description,
	},
	"recount.gpu.dram.activity": {
		name: m.gpu_dram_activity,
		description: m.gpu_dram_activity_description,
	},
	"recount.gpu.utilization": {
		name: m.gpu_utilization,
		description: m.gpu_utilization_description,
	},
	"recount.gpu.memory.activity": {
		name: m.gpu_memory_activity,
		description: m.gpu_memory_activity_description,
	},
	"recount.gpu.memory.total": {
		name: m.gpu_memory_total,
		description: m.gpu_memory_total_description,
	},
	"recount.gpu.memory.used": {
		name: m.gpu_memory_used,
		description: m.gpu_memory_used_description,
	},
	"recount.gpu.power": {
		name: m.gpu_power,
		description: m.gpu_power_description,
	},
	"recount.gpu.temperature": {
		name: m.gpu_temperature,
		description: m.gpu_temperature_description,
	},
	"recount.gpu.clock": {
		name: m.gpu_clock,
		description: m.gpu_clock_description,
	},
	"recount.gpu.ecc.errors": {
		name: m.gpu_ecc,
		description: m.gpu_ecc_description,
	},
	"recount.gpu.xid.last": {
		name: m.gpu_xid,
		description: m.gpu_xid_description,
	},
	"recount.gpu.pcie.throughput": {
		name: m.gpu_pcie,
		description: m.gpu_pcie_description,
	},
	"recount.gpu.nvlink.throughput": {
		name: m.gpu_nvlink,
		description: m.gpu_nvlink_description,
	},
	"recount.gpu.discovery.status": {
		name: m.gpu_discovery,
		description: m.gpu_discovery_description,
	},
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
		description: m.metric_process_detail_description,
		detail: true,
	},
	"recount.process.memory.rss": {
		name: m.metric_process_memory_rss,
		description: m.metric_process_detail_description,
		detail: true,
	},
	"process.disk.io": {
		name: m.metric_process_disk_io,
		description: m.metric_process_detail_description,
		detail: true,
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
	"process.executable.name": m.attribute_process_name,
	"process.real_user.id": m.attribute_process_real_uid,
	"recount.slurm.job.id": m.attribute_slurm_job_id,
	"recount.slurm.step.id": m.attribute_slurm_step_id,
	"process.parent_pid": m.attribute_parent_pid,
	"recount.collection.scope": m.attribute_collection_scope,
	"recount.collection.source": m.attribute_collection_source,
	"recount.collection.visibility": m.attribute_visibility,
};
const CALCULATED_NAMES: Record<string, () => string> = {
	"recount.calculated.cpu-usage": m.calculated_cpu_usage,
	"recount.calculated.memory-usage": m.calculated_memory_usage,
	"recount.calculated.process-cpu": m.calculated_process_cpu,
};

/** A readable metric name; unknown metrics show their technical name. */
export function metricLabel(name: string, label?: string) {
	return METRICS[name]?.name() ?? CALCULATED_NAMES[name]?.() ?? label ?? name;
}

export function metricDescription(name: string) {
	return METRICS[name]?.description() ?? null;
}

/**
 * The measure counting what a distribution leaves out as idle, from the collector's
 * coverage counters: its latest count per node, summed.
 */
export function idleMeasure(name: string, measure: string) {
	if (name !== "recount.node.process.cpu.utilization.distribution")
		return undefined;
	return {
		name: `${measure}_idle`,
		metric: "recount.collection.process.coverage",
		calculation: "avg" as const,
		combine: "sum" as const,
		filters: [
			{
				field: 'attributes["coverage"]',
				op: "eq" as const,
				values: ["cpu_idle"],
			},
		],
	};
}

/** Picker sections, in display order; collector diagnostics come last. */
export const METRIC_SECTIONS = [
	"node",
	"processes",
	"gpu",
	"other",
	"diagnostics",
] as const;
export type MetricSection = (typeof METRIC_SECTIONS)[number];

export const METRIC_SECTION_LABEL: Record<MetricSection, () => string> = {
	node: m.metric_section_node,
	processes: m.metric_section_processes,
	gpu: m.metric_section_gpu,
	other: m.metric_section_other,
	diagnostics: m.metric_section_diagnostics,
};

/** Where a metric is listed, by family; metrics from other sources are "other". */
export function metricSection(name: string): MetricSection {
	if (/^recount\.node\.process\./.test(name)) return "processes";
	if (/^recount\.node\.gpu\./.test(name)) return "gpu";
	if (
		/^recount\.(collection|clock)\./.test(name) ||
		name.endsWith(".discovery.status")
	)
		return "diagnostics";
	if (/^recount\.(process\.)?gpu\./.test(name)) return "gpu";
	if (
		/^(process\.|recount\.process\.|recount\.calculated\.process-)/.test(name)
	)
		return "processes";
	if (/^(recount\.node\.|system\.|recount\.calculated\.)/.test(name))
		return "node";
	return "other";
}

export function isProcessDetailMetric(name: string | null | undefined) {
	return !!name && METRICS[name]?.detail === true;
}

const PROCESS_ID = 'resource.attributes["process.pid"]';

/** The breakdown a metric opens with when members chose none: per-process detail by process. */
export function metricBreakdown(name: string | undefined) {
	return isProcessDetailMetric(name) ? PROCESS_ID : undefined;
}

/** The fields a breakdown queries: a process ID also brings its name, as in "python · 662". */
export function breakdownFields(field: string) {
	return field === PROCESS_ID
		? ['resource.attributes["process.executable.name"]', field]
		: [field];
}

/** Whether the metric has a friendly name distinct from its technical one. */
export function isNamedMetric(name: string) {
	return name in METRICS;
}

export function attributeLabel(key: string) {
	return ATTRIBUTES[key]?.() ?? key;
}

export function isNamedAttribute(key: string) {
	return key in ATTRIBUTES;
}
