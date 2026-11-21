export interface HistogramWindow {
	bucket: string;
	bounds: number[];
	counts: string[];
	count: string;
	mean: number | null;
	min: number | null;
	max: number | null;
}

export function isProcessDetailMetric(metric: string | null | undefined) {
	return (
		metric === "process.cpu.time" ||
		metric === "recount.process.memory.rss" ||
		metric === "process.disk.io"
	);
}

export function histogramRange(
	bounds: number[],
	index: number,
	format: Intl.NumberFormat,
) {
	const lower = bounds[index - 1];
	const upper = bounds[index];
	if (lower === undefined && upper === undefined) return "−∞ … +∞";
	if (lower === undefined) return `≤ ${format.format(upper)}`;
	if (upper === undefined) return `> ${format.format(lower)}`;
	return `(${format.format(lower)}, ${format.format(upper)}]`;
}
