import { m } from "@recount/i18n/messages";
import {
	type ColumnDef,
	columnFilteringFeature,
	columnVisibilityFeature,
	createFilteredRowModel,
	createSortedRowModel,
	rowSelectionFeature,
	rowSortingFeature,
	sortFn_datetime,
	sortFn_text,
	type Column as TableColumn,
	tableFeatures,
} from "@tanstack/react-table";
import { cn } from "cn";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { ReactNode } from "react";
import { UserAvatar } from "../../components/identity-avatar";
import { TimeDisplay } from "../../components/time-display";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { hasTag } from "../../lib/tags";
import type { InsightDraft } from "../insight/draft";
import { DISPLAY_ICON } from "../insight/labels";
import type { SavedInsight } from "../saved-insights";

export interface SavedRow {
	insight: SavedInsight;
	draft: InsightDraft;
}

export const savedFeatures = tableFeatures({
	rowSortingFeature,
	rowSelectionFeature,
	columnFilteringFeature,
	columnVisibilityFeature,
	sortedRowModel: createSortedRowModel(),
	filteredRowModel: createFilteredRowModel(),
	sortFns: { datetime: sortFn_datetime, text: sortFn_text },
});

/** Values that change per render reach the stable column definitions here. */
export interface SavedTableMeta {
	userId: string;
	canWrite: boolean;
	open: (insight: SavedInsight) => ReactNode;
	menu: (insight: SavedInsight) => ReactNode;
}

type Column = ColumnDef<typeof savedFeatures, SavedRow>;

const HEADER_CLASS =
	"-ml-2 h-7 px-2 text-xs font-semibold tracking-wide uppercase";

/** A header styled like the sortable ones, for columns that do not sort. */
function PlainHeader({ label }: { label: string }) {
	return (
		<Button
			asChild
			variant="ghost"
			size="sm"
			className={cn(HEADER_CLASS, "pointer-events-none")}
		>
			<span>{label}</span>
		</Button>
	);
}

function SortHeader({
	label,
	column,
}: {
	label: string;
	column: TableColumn<typeof savedFeatures, SavedRow>;
}) {
	const sorted = column.getIsSorted();
	const Icon = sorted === "asc" ? ArrowUpIcon : ArrowDownIcon;
	return (
		<Button
			variant="ghost"
			size="sm"
			className={HEADER_CLASS}
			onClick={column.getToggleSortingHandler()}
		>
			{label}
			<Icon
				aria-hidden="true"
				className={cn("size-3.5", !sorted && "opacity-0")}
			/>
		</Button>
	);
}

// Rows show the first few tags; the rest are counted.
const SHOWN_TAGS = 3;

function TagSummary({ tags }: { tags: string[] }) {
	if (!tags.length) return <span className="text-muted-foreground">—</span>;
	return (
		<span className="flex flex-wrap gap-1">
			{tags.slice(0, SHOWN_TAGS).map((tag) => (
				<Badge key={tag} variant="outline">
					{tag}
				</Badge>
			))}
			{tags.length > SHOWN_TAGS && (
				<Badge variant="secondary">
					{m.saved_more({ count: tags.length - SHOWN_TAGS })}
				</Badge>
			)}
		</span>
	);
}

const meta = (table: { options: { meta?: unknown } }) =>
	table.options.meta as SavedTableMeta;

export const savedColumns: Column[] = [
	{
		id: "select",
		meta: { className: "w-10" },
		enableSorting: false,
		header: ({ table }) => (
			<Checkbox
				checked={
					table.getIsAllPageRowsSelected() ||
					(table.getIsSomePageRowsSelected() && "indeterminate")
				}
				disabled={!meta(table).canWrite || !table.getRowModel().rows.length}
				aria-label={m.saved_select_all()}
				onCheckedChange={(value) =>
					table.toggleAllPageRowsSelected(value === true)
				}
			/>
		),
		cell: ({ row, table }) => (
			<Checkbox
				checked={row.getIsSelected()}
				disabled={!meta(table).canWrite}
				aria-label={m.saved_select({ name: row.original.insight.name })}
				onCheckedChange={(value) => row.toggleSelected(value === true)}
			/>
		),
	},
	{
		id: "name",
		accessorFn: (row) => row.insight.name,
		sortFn: "text",
		filterFn: (row, _id, value: string) =>
			row.original.insight.name
				.toLocaleLowerCase()
				.includes(value.toLocaleLowerCase()),
		header: ({ column }) => <SortHeader label={m.name()} column={column} />,
		cell: ({ row, table }) => {
			const Icon = DISPLAY_ICON[row.original.draft.display.type];
			return (
				<div className="flex min-w-0 items-start gap-3">
					<Icon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 text-primary"
					/>
					<div className="min-w-0">
						{meta(table).open(row.original.insight)}
						{row.original.insight.description && (
							<p className="line-clamp-2 text-xs whitespace-normal text-muted-foreground">
								{row.original.insight.description}
							</p>
						)}
					</div>
				</div>
			);
		},
	},
	{
		id: "tags",
		accessorFn: (row) => row.insight.tags.join(", "),
		enableSorting: false,
		meta: { className: "w-56" },
		filterFn: (row, _id, value: string[]) =>
			value.some((tag) => hasTag(row.original.insight.tags, tag)),
		header: () => <PlainHeader label={m.tags()} />,
		cell: ({ row }) => <TagSummary tags={row.original.insight.tags} />,
	},
	// Filter-only: charts are shown by the icon beside each name.
	{
		id: "type",
		accessorFn: (row) => row.draft.display.type,
		enableSorting: false,
		filterFn: (row, _id, value: string[]) =>
			value.includes(row.original.draft.display.type),
	},
	{
		id: "createdBy",
		meta: { className: "w-48" },
		accessorFn: (row) => row.insight.createdBy?.name ?? "",
		sortFn: "text",
		filterFn: (row, _id, value: string[]) =>
			value.includes(row.original.insight.createdBy?.id ?? ""),
		header: ({ column }) => (
			<SortHeader label={m.saved_created_by()} column={column} />
		),
		cell: ({ row, table }) => {
			const person = row.original.insight.createdBy;
			if (!person) return <span className="text-muted-foreground">—</span>;
			return (
				<span className="flex items-center gap-2">
					<UserAvatar user={person} className="size-6" />
					<span className="truncate">
						{person.id === meta(table).userId ? m.saved_you() : person.name}
					</span>
				</span>
			);
		},
	},
	{
		id: "createdAt",
		meta: { className: "w-36" },
		accessorFn: (row) => row.insight.createdAt,
		sortFn: "datetime",
		header: ({ column }) => (
			<SortHeader label={m.saved_created()} column={column} />
		),
		cell: ({ row }) => (
			<span className="text-muted-foreground">
				<TimeDisplay value={row.original.insight.createdAt} mode="relative" />
			</span>
		),
	},
	{
		id: "updatedAt",
		meta: { className: "w-36" },
		accessorFn: (row) => row.insight.updatedAt,
		sortFn: "datetime",
		header: ({ column }) => (
			<SortHeader label={m.saved_modified()} column={column} />
		),
		cell: ({ row }) => (
			<span className="text-muted-foreground">
				<TimeDisplay value={row.original.insight.updatedAt} mode="relative" />
			</span>
		),
	},
	{
		id: "actions",
		meta: { className: "w-12 text-right" },
		enableSorting: false,
		header: () => <span className="sr-only">{m.actions()}</span>,
		cell: ({ row, table }) => meta(table).menu(row.original.insight),
	},
];
