import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import {
	type ColumnFiltersState,
	type ColumnVisibilityState,
	type SortingState,
	useTable,
} from "@tanstack/react-table";
import { useState } from "react";
import { attributeLabel, metricLabel } from "../analytics/metric-names";
import { DataTable } from "../components/data-table";
import { Badge } from "../components/ui/badge";
import type { ProjectReference } from "../organizations/contracts";
import {
	type AttributeTableMeta,
	attributeColumns,
	attributeFeatures,
} from "./attribute-columns";
import type { AttributeEntry } from "./contracts";

// Rows link the first few metrics that carry an attribute; the rest are counted.
const SHOWN_METRICS = 4;

/** Attributes as a table whose names open their definitions; columns vary by page. */
export function AttributeTable({
	reference,
	attributes,
	label,
	columns,
	filters = [],
}: {
	reference: ProjectReference;
	attributes: AttributeEntry[];
	label: string;
	/** Which optional columns to show. */
	columns: ColumnVisibilityState;
	filters?: ColumnFiltersState;
}) {
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "key", desc: false },
	]);
	const meta: AttributeTableMeta = {
		open: (attribute) => (
			<Link
				to="/organizations/$organizationId/projects/$projectId/definitions/attributes/$scope/$key"
				params={{ ...reference, scope: attribute.scope, key: attribute.key }}
				className="font-semibold hover:underline"
			>
				{attributeLabel(attribute.key)}
			</Link>
		),
		metrics: (metrics) => (
			<span className="flex flex-wrap gap-1">
				{metrics.slice(0, SHOWN_METRICS).map((metric) => (
					<Badge key={metric} variant="outline" asChild>
						<Link
							to="/organizations/$organizationId/projects/$projectId/definitions/metrics/$metric"
							params={{ ...reference, metric }}
						>
							{metricLabel(metric)}
						</Link>
					</Badge>
				))}
				{metrics.length > SHOWN_METRICS && (
					<Badge variant="secondary">
						{m.saved_more({ count: metrics.length - SHOWN_METRICS })}
					</Badge>
				)}
			</span>
		),
	};
	const table = useTable({
		features: attributeFeatures,
		data: attributes,
		columns: attributeColumns,
		meta,
		getRowId: (row) => `${row.scope}/${row.key}/${row.kind}`,
		state: { sorting, columnFilters: filters, columnVisibility: columns },
		onSortingChange: setSorting,
	});
	return (
		<DataTable table={table} label={label} empty={m.definitions_no_match()} />
	);
}
