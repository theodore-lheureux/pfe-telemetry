import { m } from "@recount/i18n/messages";
import {
	BadgeCheckIcon,
	EyeIcon,
	EyeOffIcon,
	type LucideIcon,
} from "lucide-react";
import { capabilities } from "../analytics/capabilities";
import {
	DEFAULT_DRAFT,
	encodeDraft,
	newSeries,
} from "../analytics/insight/draft";
import type { DefinitionStatus, MetricEntry } from "./contracts";

// OTLP metric kinds as the catalog stores them.
const OTHER_KIND: Record<number, () => string> = {
	3: m.definitions_kind_histogram,
	4: m.definitions_kind_exponential,
	5: m.definitions_kind_summary,
};

/** How a metric behaves, in words: gauges and counters by behaviour, others by kind. */
export function kindLabel(
	metric: Pick<MetricEntry, "kind" | "behavior" | "calculated">,
) {
	if (metric.calculated) return m.calculated_metric();
	if (metric.behavior === "gauge") return m.definitions_kind_gauge();
	if (metric.behavior === "counter") return m.definitions_kind_counter();
	if (metric.behavior === "delta") return m.definitions_kind_delta();
	return (OTHER_KIND[metric.kind] ?? m.definitions_kind_other)();
}

// Attribute value kinds from the point contract: string, integer, double, boolean, bytes.
const VALUE_TYPE: Record<number, () => string> = {
	2: m.definitions_type_string,
	3: m.definitions_type_integer,
	4: m.definitions_type_number,
	5: m.definitions_type_boolean,
	6: m.definitions_type_bytes,
};

export function valueTypeLabel(kind: number) {
	return VALUE_TYPE[kind]?.() ?? String(kind);
}

/** A status choice; `visible` is the default, stored as no status. */
export type StatusChoice = DefinitionStatus | "visible";
export const STATUS_CHOICES: StatusChoice[] = ["verified", "visible", "hidden"];

export const STATUS: Record<
	StatusChoice,
	{
		icon: LucideIcon;
		label: () => string;
		/** What the status means for a metric and for an attribute. */
		metric: () => string;
		attribute: () => string;
	}
> = {
	verified: {
		icon: BadgeCheckIcon,
		label: m.definitions_status_verified,
		metric: m.definitions_status_verified_metric,
		attribute: m.definitions_status_verified_attribute,
	},
	visible: {
		icon: EyeIcon,
		label: m.definitions_status_visible,
		metric: m.definitions_status_visible_metric,
		attribute: m.definitions_status_visible_attribute,
	},
	hidden: {
		icon: EyeOffIcon,
		label: m.definitions_status_hidden,
		metric: m.definitions_status_hidden_metric,
		attribute: m.definitions_status_hidden_attribute,
	},
};

export const statusChoice = (status: DefinitionStatus | null): StatusChoice =>
	status ?? "visible";

/**
 * An Explore draft that charts the metric with its first allowed calculation, broken
 * down by its default breakdown when members chose one.
 */
export function exploreDraft(
	metric: Pick<
		MetricEntry,
		"name" | "behavior" | "defaultBreakdown" | "calculated"
	>,
) {
	const options = capabilities({
		...metric,
		defaultBreakdown: metric.defaultBreakdown ?? undefined,
	});
	return encodeDraft({
		...DEFAULT_DRAFT,
		series: [
			{
				...newSeries("A"),
				metric: metric.name,
				calculation: options.defaultCalculation,
				combine: options.defaultCombine,
			},
		],
		...(metric.defaultBreakdown ? { groupBy: metric.defaultBreakdown } : {}),
	});
}
