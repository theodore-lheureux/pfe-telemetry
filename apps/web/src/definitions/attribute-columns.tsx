import { m } from "@recount/i18n/messages";
import {
	type ColumnDef,
	columnFilteringFeature,
	columnVisibilityFeature,
	createFilteredRowModel,
	createSortedRowModel,
	rowSortingFeature,
	sortFn_datetime,
	sortFn_text,
	tableFeatures,
} from "@tanstack/react-table";
import type { ReactNode } from "react";
import { attributeLabel } from "../analytics/definition-labels";
import { DefinitionSourceIcon } from "../analytics/definition-source-icon";
import { PlainHeader, SortableHeader } from "../components/data-table";
import { TimeDisplay } from "../components/time-display";
import { Badge } from "../components/ui/badge";
import type { AttributeEntry } from "./contracts";
import { StatusBadge } from "./definition-parts";
import { valueTypeLabel } from "./labels";

export const attributeFeatures = tableFeatures({
	rowSortingFeature,
	columnFilteringFeature,
	columnVisibilityFeature,
	sortedRowModel: createSortedRowModel(),
	filteredRowModel: createFilteredRowModel(),
	sortFns: { datetime: sortFn_datetime, text: sortFn_text },
});

/** Values that change per render reach the stable column definitions here. */
export interface AttributeTableMeta {
	/** The attribute's name as a link to its definition. */
	open: (attribute: AttributeEntry) => ReactNode;
	/** The metrics that carry an attribute, such as links to their definitions. */
	metrics: (metrics: string[]) => ReactNode;
}

type Column = ColumnDef<typeof attributeFeatures, AttributeEntry>;

export const SCOPE_LABEL: Record<AttributeEntry["scope"], () => string> = {
	point: m.definitions_scope_point,
	resource: m.definitions_scope_resource,
};

const meta = (table: { options: { meta?: unknown } }) =>
	table.options.meta as AttributeTableMeta;

export const attributeColumns: Column[] = [
	{
		id: "source",
		meta: { className: "w-8" },
		enableSorting: false,
		header: () => null,
		cell: ({ row }) => (
			<DefinitionSourceIcon kind="attribute" name={row.original.key} />
		),
	},
	{
		id: "key",
		meta: { className: "py-3" },
		accessorFn: (row) => attributeLabel(row.key),
		sortFn: "text",
		filterFn: (row, _id, value: string) => {
			const query = value.toLocaleLowerCase();
			return [
				row.original.key,
				attributeLabel(row.original.key),
				row.original.description,
			].some((text) => text.toLocaleLowerCase().includes(query));
		},
		header: ({ column }) => <SortableHeader label={m.name()} column={column} />,
		cell: ({ row, table }) => (
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex flex-wrap items-center gap-2">
					{meta(table).open(row.original)}
					<StatusBadge status={row.original.status} quiet />
				</div>
				{row.original.description && (
					<p className="line-clamp-2 text-sm whitespace-normal text-muted-foreground">
						{row.original.description}
					</p>
				)}
			</div>
		),
	},
	// Whether an attribute describes each measurement or the source that sent it.
	{
		id: "scope",
		meta: { className: "w-32" },
		accessorFn: (row) => row.scope,
		enableSorting: false,
		filterFn: (row, _id, value: string[]) => value.includes(row.original.scope),
		header: () => <PlainHeader label={m.definitions_scope()} />,
		cell: ({ row }) => (
			<Badge variant="secondary">{SCOPE_LABEL[row.original.scope]()}</Badge>
		),
	},
	{
		id: "type",
		meta: { className: "w-28" },
		accessorFn: (row) => valueTypeLabel(row.kind),
		sortFn: "text",
		header: ({ column }) => (
			<SortableHeader label={m.definitions_type()} column={column} />
		),
		cell: ({ row }) => (
			<Badge variant="outline">{valueTypeLabel(row.original.kind)}</Badge>
		),
	},
	{
		id: "metrics",
		meta: { className: "w-[40%]" },
		accessorFn: (row) => row.metrics.length,
		enableSorting: false,
		header: () => <PlainHeader label={m.definitions_metrics()} />,
		cell: ({ row, table }) => meta(table).metrics(row.original.metrics),
	},
	// Only one metric's attributes carry examples.
	{
		id: "example",
		meta: { className: "w-56 text-right" },
		accessorFn: (row) => row.example ?? "",
		enableSorting: false,
		header: () => <PlainHeader label={m.definitions_example()} />,
		cell: ({ row }) =>
			row.original.example ? (
				<code className="inline-block max-w-56 truncate rounded border bg-background px-1.5 py-0.5 align-middle text-xs">
					{row.original.example}
				</code>
			) : (
				<span className="text-muted-foreground">—</span>
			),
	},
	{
		id: "lastSeen",
		meta: { className: "w-36" },
		accessorFn: (row) => row.lastSeen,
		sortFn: "datetime",
		header: ({ column }) => (
			<SortableHeader label={m.definitions_last_seen()} column={column} />
		),
		cell: ({ row }) => (
			<span className="text-muted-foreground">
				<TimeDisplay value={row.original.lastSeen} mode="relative" />
			</span>
		),
	},
];
