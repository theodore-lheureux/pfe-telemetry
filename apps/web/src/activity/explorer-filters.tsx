import { m } from "@recount/i18n/messages";
import { ListFilterIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { useAnalyticsCatalog, useMetricAttributes } from "../analytics/catalog";
import { type Filter, MAX_FILTERS } from "../analytics/contracts";
import { parseAttributeField } from "../analytics/fields";
import { attributeLabel } from "../analytics/metric-names";
import { MetricPicker } from "../analytics/metric-picker";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { ProjectReference } from "../organizations/contracts";
import { AttributeFilter, OPERATOR_LABEL } from "./attribute-filter";
import type { DateRange } from "./date-range";
import { DateRangePicker } from "./date-range-picker";

/** What the Explorer shows; the range resolves to bounds when a query runs. */
export interface ExplorerSelection {
	range: DateRange;
	metric?: string;
	filters: Filter[];
}

function filterKey(filter: Filter) {
	return JSON.stringify([filter.field, filter.op, filter.values ?? []]);
}

function filterText(filter: Filter) {
	const name = attributeLabel(
		parseAttributeField(filter.field)?.key ?? filter.field,
	);
	if (filter.op === "exists" || filter.op === "not_exists")
		return `${name} ${OPERATOR_LABEL[filter.op]()}`;
	return `${name} ${filter.op === "eq" || filter.op === "in" ? "=" : "≠"} ${filter.values?.join(", ") ?? ""}`;
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
					// An identical filter adds nothing, and filters are keyed by content.
					if (
						!value.filters.some(
							(other) => filterKey(other) === filterKey(filter),
						)
					)
						onChange({ ...value, filters: [...value.filters, filter] });
				}}
			/>
			{value.filters.map((filter, index) => (
				<Badge
					key={filterKey(filter)}
					variant="outline"
					className="h-8 max-w-72 gap-1 border-primary/60 pr-1 pl-2.5 text-sm font-normal"
				>
					<span className="truncate">{filterText(filter)}</span>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={m.activity_filter_remove({
							filter: filterText(filter),
						})}
						disabled={disabled}
						onClick={() =>
							onChange({
								...value,
								filters: value.filters.filter((_, other) => other !== index),
							})
						}
					>
						<XIcon aria-hidden="true" />
					</Button>
				</Badge>
			))}
		</>
	);
}
