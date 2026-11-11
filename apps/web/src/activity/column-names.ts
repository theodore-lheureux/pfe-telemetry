import { m } from "@recount/i18n/messages";
import { parseAttributeField } from "../analytics/fields";
import { attributeLabel } from "../analytics/metric-names";
import { type BuiltInColumn, isBuiltIn } from "./columns";

export type ColumnCategory = "fields" | "point" | "resource";

const BUILT_IN_NAME: Record<BuiltInColumn, () => string> = {
	metric: m.activity_metric,
	node: m.activity_node,
	resource: m.activity_resource,
	value: m.activity_value,
	time: m.activity_measured,
	unit: m.columns_unit,
	scope: m.columns_scope,
	source: m.activity_source,
};

export function columnCategory(field: string): ColumnCategory {
	if (isBuiltIn(field)) return "fields";
	return parseAttributeField(field)?.scope ?? "point";
}

/** The technical name: the field for built-ins, the attribute key otherwise. */
export function columnKey(field: string) {
	return parseAttributeField(field)?.key ?? field;
}

/** The readable default header of a column. */
export function columnName(field: string) {
	if (isBuiltIn(field)) return BUILT_IN_NAME[field]();
	return attributeLabel(columnKey(field));
}
