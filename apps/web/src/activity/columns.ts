import { parseField } from "../analytics/validation";

// Explorer columns are logical fields: the built-in point fields below, or a point or
// resource attribute written in the semantic model's field syntax.

export const BUILT_IN_COLUMNS = [
	"metric",
	"node",
	"resource",
	"value",
	"time",
	"unit",
	"scope",
	"source",
] as const;
export type BuiltInColumn = (typeof BUILT_IN_COLUMNS)[number];

export interface ExplorerColumn {
	field: string;
	/** A custom header; absent means the field's own name. */
	label?: string;
}

export const DEFAULT_COLUMNS: ExplorerColumn[] = [
	{ field: "metric" },
	{ field: "node" },
	{ field: "resource" },
	{ field: "value" },
	{ field: "time" },
];
export const MAX_COLUMNS = 20;
/** Attribute columns each add a projection to every Explorer read. */
export const MAX_ATTRIBUTE_COLUMNS = 10;
export const MAX_COLUMN_LABEL = 60;

export interface ExplorerColumnSettings {
	columns: ExplorerColumn[];
	/** What "Reset to defaults" restores: the project default, else the built-in set. */
	defaults: ExplorerColumn[];
	/** Whether this member may save the project default. */
	canSetDefault: boolean;
}

export function isBuiltIn(field: string): field is BuiltInColumn {
	return (BUILT_IN_COLUMNS as readonly string[]).includes(field);
}

export function attributeFields(columns: ExplorerColumn[]) {
	return columns
		.map((column) => column.field)
		.filter((field) => !isBuiltIn(field));
}

export function sameColumns(a: ExplorerColumn[], b: ExplorerColumn[]) {
	return (
		a.length === b.length &&
		a.every(
			(column, index) =>
				column.field === b[index]?.field && column.label === b[index]?.label,
		)
	);
}

/** Validates a column set; attribute fields must use the semantic model's syntax. */
export function parseColumns(value: unknown): ExplorerColumn[] {
	if (!Array.isArray(value) || !value.length || value.length > MAX_COLUMNS)
		throw new Error("Invalid column set");
	const seen = new Set<string>();
	let attributes = 0;
	return value.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error("Invalid column");
		const { field, label } = entry as Record<string, unknown>;
		if (typeof field !== "string" || seen.has(field))
			throw new Error("Invalid column field");
		seen.add(field);
		if (!isBuiltIn(field)) {
			const parsed = parseField(field);
			if (parsed.type !== "attribute") throw new Error("Invalid column field");
			if (++attributes > MAX_ATTRIBUTE_COLUMNS)
				throw new Error("Too many attribute columns");
		}
		if (label === undefined) return { field };
		if (
			typeof label !== "string" ||
			!label.trim() ||
			label.length > MAX_COLUMN_LABEL ||
			/\p{Cc}/u.test(label)
		)
			throw new Error("Invalid column label");
		return { field, label: label.trim() };
	});
}

/** Columns read back from storage; an unreadable set falls back to the defaults. */
export function storedColumns(value: unknown, fallback: ExplorerColumn[]) {
	try {
		return parseColumns(value);
	} catch {
		return fallback;
	}
}
