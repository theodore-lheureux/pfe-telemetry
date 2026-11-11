import { m } from "@recount/i18n/messages";
import { ListFilterIcon } from "lucide-react";
import { useState } from "react";
import { AttributeFilter } from "../analytics/attribute-filter";
import { useAnalyticsCatalog, useMetricAttributes } from "../analytics/catalog";
import { type Filter, MAX_FILTERS } from "../analytics/contracts";
import { FilterChips, withFilter } from "../analytics/filter-chips";
import { MetricPicker } from "../analytics/metric-picker";
import type { DateRange } from "../components/date-range/date-range";
import { DateRangePicker } from "../components/date-range/date-range-picker";
import { cn } from "../lib/utils";
import type { ProjectReference } from "../organizations/contracts";

/** What the Explorer shows; the range resolves to bounds when a query runs. */
export interface ExplorerSelection {
	range: DateRange;
	metric?: string;
	filters: Filter[];
}

/** Time range, metric and attribute filters for the Explorer's point list. */
export function ExplorerFilterBar({
	userId,
	reference,
	value,
	disabled,
	onChange,
}: {
	userId: string;
	reference: ProjectReference;
	value: ExplorerSelection;
	disabled: boolean;
	onChange: (value: ExplorerSelection) => void;
}) {
	const [wantsAttributes, setWantsAttributes] = useState(false);
	const catalog = useAnalyticsCatalog(userId, reference, !disabled);
	const attributes = useMetricAttributes(
		userId,
		reference,
		value.metric,
		wantsAttributes,
	);
	return (
		<>
			<DateRangePicker
				value={value.range}
				disabled={disabled}
				onChange={(range) => onChange({ ...value, range })}
			/>
			<MetricPicker
				metrics={catalog.data?.metrics}
				value={value.metric}
				disabled={disabled}
				placeholder={m.activity_metric_filter()}
				allLabel={m.activity_metric_all()}
				icon={<ListFilterIcon aria-hidden="true" />}
				className={cn("max-w-72", value.metric && "border-primary/60")}
				onChange={(metric) => onChange({ ...value, metric })}
			/>
			<AttributeFilter
				attributes={attributes.data}
				loading={attributes.isFetching}
				disabled={disabled || value.filters.length >= MAX_FILTERS}
				onOpen={() => setWantsAttributes(true)}
				onAdd={(filter) => {
					onChange({ ...value, filters: withFilter(value.filters, filter) });
				}}
			/>
			<FilterChips
				filters={value.filters}
				disabled={disabled}
				onChange={(filters) => onChange({ ...value, filters })}
			/>
		</>
	);
}
