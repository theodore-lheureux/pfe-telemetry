import { m } from "@recount/i18n/messages";

// Friendly names for the metrics Recount's collector sends. Other metrics, including
// any sent by standard OpenTelemetry exporters, keep their technical names.
export const METRIC_NAMES: Record<
	string,
	{
		name: () => string;
		description: () => string;
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
	},
	"recount.process.memory.rss": {
		name: m.metric_process_memory_rss,
		description: m.metric_process_detail_description,
	},
	"process.disk.io": {
		name: m.metric_process_disk_io,
		description: m.metric_process_detail_description,
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
	"recount.calculated.cpu-usage": {
		name: m.calculated_cpu_usage,
		description: m.calculated_cpu_usage_description,
	},
	"recount.calculated.memory-usage": {
		name: m.calculated_memory_usage,
		description: m.calculated_memory_usage_description,
	},
	"recount.calculated.process-cpu": {
		name: m.calculated_process_cpu,
		description: m.calculated_process_cpu_description,
	},
};
