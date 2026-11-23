import { isRatioMetric } from "./metric-names";

export function heatColor(ratio: number) {
	return `color-mix(in oklab, var(--chart-1) ${100 * Math.min(1, Math.max(0, ratio))}%, var(--muted))`;
}

export const DISTRIBUTIONS: Readonly<Record<string, string>> = {
	"process.cpu.time": "recount.node.process.cpu.utilization.distribution",
	"recount.calculated.process-cpu":
		"recount.node.process.cpu.utilization.distribution",
	"recount.process.memory.rss": "recount.node.process.memory.rss.distribution",
	"process.disk.io": "recount.node.process.disk.io.rate.distribution",
};

export interface HistogramWindow {
	bucket: string;
	bounds: number[];
	counts: string[];
}

export function isProcessDetailMetric(metric: string | null | undefined) {
	return (
		metric === "process.cpu.time" ||
		metric === "recount.process.memory.rss" ||
		metric === "process.disk.io"
	);
}

export function histogramFormatter(
	unit: string,
	metric: string,
	locale: string,
	magnitude = 0,
) {
	let scale = 1;
	let suffix = unit === "1" ? "" : unit;
	if (unit === "%" || (unit === "1" && isRatioMetric(metric))) {
		scale = unit === "%" ? 1 : 100;
		suffix = "%";
	} else if (unit === "s") {
		scale = 1000;
		suffix = "ms";
	} else if (unit === "By" || unit === "By/s") {
		const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
		const index = Math.min(
			4,
			Math.max(
				0,
				Math.floor(Math.log(Math.max(1, magnitude)) / Math.log(1024)),
			),
		);
		scale = 1024 ** -index;
		suffix = `${sizes[index]}${unit === "By/s" ? "/s" : ""}`;
	}
	const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 });
	const label = (text: string) => (suffix ? `${text}\u00a0${suffix}` : text);
	const scalar = (value: number) => number.format(value * scale);
	return {
		value: (value: number) => label(scalar(value)),
		range: (bounds: number[], index: number) => {
			const lower = bounds[index - 1],
				upper = bounds[index];
			if (lower === undefined && upper === undefined) return "−∞ … +∞";
			if (lower === undefined) return label(`≤ ${scalar(upper)}`);
			if (upper === undefined) return label(`> ${scalar(lower)}`);
			return label(`${scalar(lower)}–${scalar(upper)}`);
		},
	};
}

export function histogramQuantile(
	layouts: { bounds: number[]; counts: string[] }[],
	level: number,
) {
	const common =
		layouts[0]?.bounds.filter((bound) =>
			layouts.every(({ bounds }) => bounds.includes(bound)),
		) ?? [];
	if (!common.length) return null;
	const pooled = Array<number>(common.length + 1).fill(0);
	for (const { bounds, counts } of layouts) {
		let target = 0;
		for (const [index, count] of counts.entries()) {
			pooled[target] += Number(count);
			if (bounds[index] === common[target] && target < common.length) target++;
		}
	}
	const total = pooled.reduce((sum, count) => sum + count, 0);
	if (!total) return null;
	const rank = total * level;
	let before = 0;
	for (const [index, count] of pooled.entries()) {
		if (count && before + count >= rank) {
			const lower = common[index - 1],
				upper = common[index];
			if (lower === undefined) return upper;
			if (upper === undefined) return lower;
			return lower + (upper - lower) * ((rank - before) / count);
		}
		before += count;
	}
	return null;
}
