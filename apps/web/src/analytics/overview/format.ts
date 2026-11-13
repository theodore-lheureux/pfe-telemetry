import { m } from "@recount/i18n/messages";
import type { OverviewStat } from "../overview.server";

export const STAT_LABEL: Record<OverviewStat, () => string> = {
	nodes: m.stat_nodes,
	cpu: m.stat_cpu,
	memory: m.stat_memory,
	processes: m.stat_processes,
};
export const STAT_DESCRIPTION: Record<OverviewStat, () => string> = {
	nodes: m.stat_nodes_description,
	cpu: m.stat_cpu_description,
	memory: m.stat_memory_description,
	processes: m.stat_processes_description,
};
export const RATIOS = new Set<OverviewStat>(["cpu", "memory"]);

/** Ratios as percentages, counts compactly; a dash when there is no value. */
export function formatStat(
	stat: OverviewStat,
	value: number | null,
	locale: string,
) {
	if (value === null) return "—";
	if (RATIOS.has(stat))
		return new Intl.NumberFormat(locale, {
			style: "percent",
			maximumFractionDigits: 1,
		}).format(value);
	return new Intl.NumberFormat(locale, {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}
