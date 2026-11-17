import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
export function workflowLabels() {
	return {
		"create-cpu": m.developer_create_cpu(),
		"create-gpu": m.developer_create_gpu(),
		configure: m.developer_configure(),
		move: m.developer_move(),
		list: m.developer_list(),
		destroy: m.developer_destroy(),
		"load-cpu": m.developer_load_cpu(),
		"load-gpu": m.developer_load_gpu(),
		"load-status": m.developer_load_status(),
		"stop-load": m.developer_stop_load(),
	};
}

export function profileLabels() {
	return {
		"cpu-hash": m.developer_cpu_hash(),
		"cpu-primes": m.developer_cpu_primes(),
		"cpu-pi": m.developer_cpu_pi(),
		"gpu-fp32": m.developer_gpu_fp32(),
		"gpu-tensor": m.developer_gpu_tensor(),
		"gpu-memory": m.developer_gpu_memory(),
		"gpu-mixed": m.developer_gpu_mixed(),
	};
}

export function durationLabels() {
	const minutes = new Intl.NumberFormat(getLocale(), {
		style: "unit",
		unit: "minute",
		unitDisplay: "long",
	});
	return {
		"60": minutes.format(1),
		"120": minutes.format(2),
		"180": minutes.format(3),
		"300": minutes.format(5),
	};
}

export function ttlLabels() {
	const minutes = new Intl.NumberFormat(getLocale(), {
		style: "unit",
		unit: "minute",
		unitDisplay: "long",
	});
	const hours = new Intl.NumberFormat(getLocale(), {
		style: "unit",
		unit: "hour",
		unitDisplay: "long",
	});
	return {
		"15m": minutes.format(15),
		"30m": minutes.format(30),
		"1h": hours.format(1),
		"2h": hours.format(2),
		"4h": hours.format(4),
	};
}
