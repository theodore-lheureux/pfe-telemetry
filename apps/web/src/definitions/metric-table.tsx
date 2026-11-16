import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import {
	type ColumnFiltersState,
	type ColumnVisibilityState,
	type SortingState,
	useTable,
} from "@tanstack/react-table";
import { useState } from "react";
import { metricLabel } from "../analytics/metric-names";
import { DataTable } from "../components/data-table";
import type { ProjectReference } from "../organizations/contracts";
import type { MetricEntry } from "./contracts";
import { MetricAttributesPanel } from "./metric-attributes-panel";
import {
	type MetricTableMeta,
	metricColumns,
	metricFeatures,
} from "./metric-columns";

/**
 * Metrics as a table whose names open their definitions and whose rows expand to show
 * their attributes; pages choose which optional columns to show.
 */
export function MetricTable({
	userId,
	reference,
	metrics,
	label,
	filters = [],
	columns = {},
}: {
	userId: string;
	reference: ProjectReference;
	metrics: MetricEntry[];
	label: string;
	filters?: ColumnFiltersState;
	columns?: ColumnVisibilityState;
}) {
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "name", desc: false },
	]);
	const [open, setOpen] = useState(new Set<string>());
	const meta: MetricTableMeta = {
		open: (metric) => (
			<Link
				to="/organizations/$organizationId/projects/$projectId/definitions/metrics/$metric"
				params={{ ...reference, metric: metric.name }}
				className="font-semibold hover:underline"
			>
				{metricLabel(metric.name, metric.label)}
			</Link>
		),
		expanded: (metric) => open.has(metric.name),
		toggle: (metric) =>
			setOpen((current) => {
				const next = new Set(current);
				if (!next.delete(metric.name)) next.add(metric.name);
				return next;
			}),
	};
	const table = useTable({
		features: metricFeatures,
		data: metrics,
		columns: metricColumns,
		meta,
		getRowId: (row) => row.name,
		state: {
			sorting,
			columnFilters: filters,
			columnVisibility: { status: false, ...columns },
		},
		onSortingChange: setSorting,
	});
	return (
		<DataTable
			table={table}
			label={label}
			empty={m.definitions_no_match()}
			expanded={(metric) =>
				open.has(metric.name) && (
					<MetricAttributesPanel
						userId={userId}
						reference={reference}
						metric={metric}
					/>
				)
			}
		/>
	);
}
