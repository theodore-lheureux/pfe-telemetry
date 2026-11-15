import { m } from "@recount/i18n/messages";
import { TriangleAlertIcon } from "lucide-react";
import type { QueryResult } from "../contracts";

/**
 * Percentiles taken over too few values to differ from the largest one. A level p needs
 * about 1 / (1 − p) values: 10 for p90, 20 for p95, 100 for p99. The median is exempt.
 */
export function thinPercentiles(result: QueryResult) {
	const byLevel = new Map<number, number>();
	for (const series of result.series) {
		const percentile = series.percentile;
		if (!percentile || percentile.level <= 0.5) continue;
		const needed = Math.ceil(1 / (1 - percentile.level) - 1e-9);
		if (percentile.values >= needed) continue;
		byLevel.set(
			percentile.level,
			Math.max(byLevel.get(percentile.level) ?? 0, percentile.values),
		);
	}
	return [...byLevel].map(([level, values]) => ({
		label: `p${Math.round(level * 100)}`,
		values,
		needed: Math.ceil(1 / (1 - level) - 1e-9),
	}));
}

/** Warns, per percentile level, when there are too few values for it to mean much. */
export function PercentileWarning({ result }: { result: QueryResult }) {
	const thin = thinPercentiles(result);
	if (!thin.length) return null;
	return (
		<div className="flex flex-col gap-0.5">
			{thin.map((entry) => {
				const text = m.insight_percentile_thin({
					percentile: entry.label,
					values: entry.values,
					needed: entry.needed,
				});
				return (
					<p
						key={entry.label}
						className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
					>
						<TriangleAlertIcon
							aria-hidden="true"
							className="mt-px size-3.5 shrink-0"
						/>
						<span>{text}</span>
					</p>
				);
			})}
		</div>
	);
}
