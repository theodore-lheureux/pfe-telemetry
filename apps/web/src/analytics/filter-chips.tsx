import { m } from "@recount/i18n/messages";
import { XIcon } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { OPERATOR_LABEL } from "./attribute-filter";
import type { Filter } from "./contracts";
import { parseAttributeField } from "./fields";
import { attributeLabel } from "./metric-names";

export function filterKey(filter: Filter) {
	return JSON.stringify([filter.field, filter.op, filter.values ?? []]);
}

/** Adds a filter unless an identical one is present; filters are keyed by content. */
export function withFilter(filters: Filter[], filter: Filter) {
	return filters.some((other) => filterKey(other) === filterKey(filter))
		? filters
		: [...filters, filter];
}

export function filterText(filter: Filter) {
	const name = attributeLabel(
		parseAttributeField(filter.field)?.key ?? filter.field,
	);
	if (filter.op === "exists" || filter.op === "not_exists")
		return `${name} ${OPERATOR_LABEL[filter.op]()}`;
	return `${name} ${filter.op === "eq" || filter.op === "in" ? "=" : "≠"} ${filter.values?.join(", ") ?? ""}`;
}

/** Applied filters as removable chips. */
export function FilterChips({
	filters,
	disabled,
	onChange,
}: {
	filters: Filter[];
	disabled: boolean;
	onChange: (filters: Filter[]) => void;
}) {
	return filters.map((filter, index) => (
		<Badge
			key={filterKey(filter)}
			variant="outline"
			className="h-8 max-w-72 gap-1 border-primary/60 pr-1 pl-2.5 text-sm font-normal"
		>
			<span className="truncate">{filterText(filter)}</span>
			<Button
				variant="ghost"
				size="icon-xs"
				aria-label={m.activity_filter_remove({ filter: filterText(filter) })}
				disabled={disabled}
				onClick={() => onChange(filters.filter((_, other) => other !== index))}
			>
				<XIcon aria-hidden="true" />
			</Button>
		</Badge>
	));
}
