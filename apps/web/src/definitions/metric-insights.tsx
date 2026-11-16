import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import {
	type ColumnDef,
	createSortedRowModel,
	rowSortingFeature,
	type SortingState,
	sortFn_datetime,
	sortFn_text,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import { useState } from "react";
import { CreatorCell } from "../analytics/saved/saved-columns";
import {
	DataTable,
	PlainHeader,
	SortableHeader,
} from "../components/data-table";
import { TimeDisplay } from "../components/time-display";
import { Badge } from "../components/ui/badge";
import type { ProjectReference } from "../organizations/contracts";
import type { MetricInsight } from "./contracts";

const features = tableFeatures({
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	sortFns: { datetime: sortFn_datetime, text: sortFn_text },
});

interface Meta {
	userId: string;
	reference: ProjectReference;
}

const meta = (table: { options: { meta?: unknown } }) =>
	table.options.meta as Meta;

const columns: ColumnDef<typeof features, MetricInsight>[] = [
	{
		id: "name",
		accessorFn: (row) => row.name,
		sortFn: "text",
		header: ({ column }) => <SortableHeader label={m.name()} column={column} />,
		cell: ({ row, table }) => (
			<div className="flex min-w-0 flex-col gap-0.5">
				<Link
					to="/organizations/$organizationId/projects/$projectId/explore"
					params={meta(table).reference}
					search={{ insight: row.original.id }}
					className="font-medium hover:underline"
				>
					{row.original.name}
				</Link>
				{row.original.description && (
					<p className="line-clamp-2 text-xs whitespace-normal text-muted-foreground">
						{row.original.description}
					</p>
				)}
			</div>
		),
	},
	{
		id: "dashboards",
		meta: { className: "w-64" },
		accessorFn: (row) => row.dashboards.length,
		enableSorting: false,
		header: () => <PlainHeader label={m.dashboards()} />,
		cell: ({ row, table }) =>
			row.original.dashboards.length ? (
				<span className="flex flex-wrap gap-1">
					{row.original.dashboards.map((dashboard) => (
						<Badge key={dashboard.id} variant="outline" asChild>
							<Link
								to="/organizations/$organizationId/projects/$projectId/dashboards/$dashboardId"
								params={{
									...meta(table).reference,
									dashboardId: dashboard.id,
								}}
							>
								{dashboard.name}
							</Link>
						</Badge>
					))}
				</span>
			) : (
				<span className="text-muted-foreground">—</span>
			),
	},
	{
		id: "createdBy",
		meta: { className: "w-44" },
		accessorFn: (row) => row.createdBy?.name ?? "",
		sortFn: "text",
		header: ({ column }) => (
			<SortableHeader label={m.saved_created_by()} column={column} />
		),
		cell: ({ row, table }) => (
			<CreatorCell
				person={row.original.createdBy}
				userId={meta(table).userId}
			/>
		),
	},
	{
		id: "updatedAt",
		meta: { className: "w-36" },
		accessorFn: (row) => row.updatedAt,
		sortFn: "datetime",
		header: ({ column }) => (
			<SortableHeader label={m.saved_modified()} column={column} />
		),
		cell: ({ row }) => (
			<span className="text-muted-foreground">
				<TimeDisplay value={row.original.updatedAt} mode="relative" />
			</span>
		),
	},
];

/** Saved insights that chart a metric, newest change first. */
export function MetricInsights({
	userId,
	reference,
	insights,
}: {
	userId: string;
	reference: ProjectReference;
	insights: MetricInsight[];
}) {
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "updatedAt", desc: true },
	]);
	const table = useTable({
		features,
		data: insights,
		columns,
		meta: { userId, reference } satisfies Meta,
		getRowId: (row) => row.id,
		state: { sorting },
		onSortingChange: setSorting,
	});
	return (
		<DataTable
			table={table}
			label={m.definitions_metric_insights()}
			empty={m.definitions_no_insights()}
		/>
	);
}
