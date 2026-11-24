import { m } from "@recount/i18n/messages";
import { METRIC_NAMES } from "./metric-names";

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

export function isNamedMetric(name: string) {
	return Object.hasOwn(METRIC_NAMES, name);
}

export function metricLabel(name: string, label?: string) {
	return isNamedMetric(name) ? METRIC_NAMES[name].name() : (label ?? name);
}

export function metricDescription(name: string) {
	return isNamedMetric(name) ? METRIC_NAMES[name].description() : null;
}

export function attributeLabel(key: string) {
	return isNamedAttribute(key) ? ATTRIBUTES[key]() : key;
}

export function isNamedAttribute(key: string) {
	return Object.hasOwn(ATTRIBUTES, key);
}
