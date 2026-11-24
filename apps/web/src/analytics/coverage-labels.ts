import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { countText } from "./metric-units";

export function coverageSummary(
	summary:
		| {
				shown: number | null;
				total: number | null;
				nodes: number | null;
				unit: string;
		  }
		| undefined,
) {
	if (
		!summary ||
		summary.shown === null ||
		summary.total === null ||
		summary.nodes === null
	)
		return m.metric_coverage_partial();
	const numbers = new Intl.NumberFormat(getLocale());
	return m.metric_coverage_summary({
		shown: numbers.format(summary.shown),
		total: countText(
			summary.unit,
			numbers.format(summary.total),
			summary.total,
		),
		nodes: numbers.format(summary.nodes),
	});
}

export function coverageOmissionLabel(
	reason: string | undefined,
	count: string,
) {
	return reason === "idle"
		? m.histogram_idle({ count })
		: m.metric_coverage_omitted_count({ count });
}
