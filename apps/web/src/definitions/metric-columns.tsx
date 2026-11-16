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
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DefinitionSourceIcon } from "../analytics/definition-source-icon";
import {
	metricDescription,
	metricLabel,
	unitLabel,
} from "../analytics/metric-names";
import { TagSummary } from "../analytics/saved/saved-columns";
import { PlainHeader, SortableHeader } from "../components/data-table";
import { TimeDisplay } from "../components/time-display";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { hasTag } from "../lib/tags";
import type { MetricEntry } from "./contracts";
import { PersonName, StatusBadge } from "./definition-parts";
import { kindLabel } from "./labels";

export const metricFeatures = tableFeatures({
	rowSortingFeature,
	columnFilteringFeature,
	columnVisibilityFeature,
	sortedRowModel: createSortedRowModel(),
	filteredRowModel: createFilteredRowModel(),
	sortFns: { datetime: sortFn_datetime, text: sortFn_text },
});

/** Values that change per render reach the stable column definitions here. */
export interface MetricTableMeta {
	open: (metric: MetricEntry) => ReactNode;
	expanded: (metric: MetricEntry) => boolean;
	toggle: (metric: MetricEntry) => void;
}

type Column = ColumnDef<typeof metricFeatures, MetricEntry>;

const meta = (table: { options: { meta?: unknown } }) =>
	table.options.meta as MetricTableMeta;

/** What describes a metric before members do: its instrumentation, then Recount's own wording. */
export function defaultDescription(metric: MetricEntry) {
	return metric.collectedDescription || metricDescription(metric.name) || "";
}

/** A metric's description: the members' own, otherwise its default one. */
export function shownDescription(metric: MetricEntry) {
	return metric.description || defaultDescription(metric);
}

export const metricColumns: Column[] = [
	{
		id: "expand",
		meta: { className: "w-10" },
		enableSorting: false,
		header: () => null,
		cell: ({ row, table }) => {
			const open = meta(table).expanded(row.original);
			const Icon = open ? ChevronDownIcon : ChevronRightIcon;
			return (
				<Button
					variant="ghost"
					size="icon-sm"
					// Only the arrow marks an open row; the row keeps its normal colour.
					className="aria-expanded:bg-muted"
					aria-expanded={open}
					aria-label={m.definitions_show_attributes({
						name: metricLabel(row.original.name, row.original.label),
					})}
					onClick={() => meta(table).toggle(row.original)}
				>
					<Icon aria-hidden="true" />
				</Button>
			);
		},
	},
	{
		id: "source",
		meta: { className: "w-8" },
		enableSorting: false,
		header: () => null,
		cell: ({ row }) => (
			<DefinitionSourceIcon kind="metric" name={row.original.name} />
		),
	},
	{
		id: "name",
		meta: { className: "py-3" },
		accessorFn: (row) => metricLabel(row.name, row.label),
		sortFn: "text",
		filterFn: (row, _id, value: string) => {
			const query = value.toLocaleLowerCase();
			return [
				row.original.name,
				metricLabel(row.original.name, row.original.label),
				shownDescription(row.original),
			].some((text) => text.toLocaleLowerCase().includes(query));
		},
		header: ({ column }) => <SortableHeader label={m.name()} column={column} />,
		cell: ({ row, table }) => (
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex flex-wrap items-center gap-2">
					{meta(table).open(row.original)}
					<StatusBadge status={row.original.status} quiet />
				</div>
				{shownDescription(row.original) && (
					<p className="line-clamp-2 text-sm whitespace-normal text-muted-foreground">
						{shownDescription(row.original)}
					</p>
				)}
			</div>
		),
	},
	{
		id: "kind",
		meta: { className: "w-36" },
		accessorFn: (row) => kindLabel(row),
		sortFn: "text",
		header: ({ column }) => (
			<SortableHeader label={m.definitions_kind()} column={column} />
		),
		cell: ({ row }) => (
			<Badge variant="outline">{kindLabel(row.original)}</Badge>
		),
	},
	{
		id: "unit",
		meta: { className: "w-28" },
		accessorFn: (row) => unitLabel(row.unit),
		sortFn: "text",
		header: ({ column }) => (
			<SortableHeader label={m.definitions_unit()} column={column} />
		),
		cell: ({ row }) =>
			unitLabel(row.original.unit) || (
				<span className="text-muted-foreground">—</span>
			),
	},
	{
		id: "tags",
		meta: { className: "w-56" },
		accessorFn: (row) => row.tags.join(", "),
		enableSorting: false,
		filterFn: (row, _id, value: string[]) =>
			value.some((tag) => hasTag(row.original.tags, tag)),
		header: () => <PlainHeader label={m.tags()} />,
		cell: ({ row }) => <TagSummary tags={row.original.tags} />,
	},
	// Filter-only: the status shows as a badge beside each name.
	{
		id: "status",
		accessorFn: (row) => row.status ?? "visible",
		enableSorting: false,
		filterFn: (row, _id, value: string[]) =>
			value.includes(row.original.status ?? "visible"),
	},
	{
		id: "owner",
		meta: { className: "w-44" },
		accessorFn: (row) => row.owner?.name ?? "",
		sortFn: "text",
		filterFn: (row, _id, value: string[]) =>
			value.includes(row.original.owner?.id ?? ""),
		header: ({ column }) => (
			<SortableHeader label={m.definitions_owner()} column={column} />
		),
		cell: ({ row }) =>
			row.original.owner ? (
				<PersonName person={row.original.owner} />
			) : (
				<span className="text-muted-foreground">—</span>
			),
	},
	{
		id: "lastSeen",
		meta: { className: "w-40" },
		accessorFn: (row) => (row.calculated ? undefined : row.lastSeen),
		sortUndefined: "last",
		sortFn: "datetime",
		header: ({ column }) => (
			<SortableHeader label={m.definitions_last_seen()} column={column} />
		),
		cell: ({ row }) => (
			<span className="text-muted-foreground">
				{row.original.calculated ? (
					"—"
				) : (
					<TimeDisplay value={row.original.lastSeen} mode="relative" />
				)}
			</span>
		),
	},
];
