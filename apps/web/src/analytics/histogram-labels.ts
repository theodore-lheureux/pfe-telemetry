import { m } from "@recount/i18n/messages";

const QUANTITIES = {
	cpu: [m.histogram_process_cpu, m.histogram_range_process_cpu],
	memory: [m.histogram_process_memory, m.histogram_range_process_memory],
	disk_io: [m.histogram_process_disk, m.histogram_range_process_disk],
	utilization: [m.histogram_gpu_utilization, m.histogram_range_gpu_utilization],
	gpu_memory: [m.histogram_gpu_memory, m.histogram_range_gpu_memory],
	power: [m.histogram_gpu_power, m.histogram_range_gpu_power],
	rtt: [m.histogram_tcp_rtt, m.histogram_range_tcp_rtt],
} satisfies Record<
	string,
	readonly [() => string, (input: { range: string }) => string]
>;

export function histogramLabels(
	quantity: string | undefined,
	fallback: string,
) {
	const entry =
		quantity && Object.hasOwn(QUANTITIES, quantity)
			? QUANTITIES[quantity as keyof typeof QUANTITIES]
			: undefined;
	return {
		quantity: entry?.[0]() ?? fallback,
		range: entry?.[1] ?? m.histogram_range_default,
	};
}
