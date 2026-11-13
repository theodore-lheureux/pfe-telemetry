import { m } from "@recount/i18n/messages";
import {
	type ColumnDef,
	createSortedRowModel,
	rowSortingFeature,
	type SortingState,
	sortFn_basic,
	sortFn_text,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import { type ReactNode, useState } from "react";
import { formatMeasurement } from "../../activity/format";
import { DataTable, SortableHeader } from "../../components/data-table";
import { LoadingBar } from "../../components/loading-bar";
import { Skeleton } from "../../components/ui/skeleton";
import type { OverviewSection } from "../contracts";
import type { OverviewNode } from "../overview.server";
import { formatStat } from "./format";

const features = tableFeatures({
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	sortFns: { basic: sortFn_basic, text: sortFn_text },
});

type Meta = { locale: string; pending: ReadonlySet<OverviewSection> };
type TableLike = { options: { meta?: unknown } };
const metaOf = (table: TableLike) => table.options.meta as Meta;
const localeOf = (table: TableLike) => metaOf(table).locale;
const NUMERIC = { className: "text-right" };

/** A section's cell: a placeholder until the section loads. */
function SectionCell({
	section,
	table,
	children,
}: {
	section: OverviewSection;
	table: TableLike;
	children: ReactNode;
}) {
	if (metaOf(table).pending.has(section))
		return <Skeleton className="ml-auto h-4 w-16" />;
	return children;
}

/** A value with a thin proportional bar, so nodes compare at a glance. */
function Meter({ value, label }: { value: number | null; label: string }) {
	return (
		<span className="flex items-center justify-end gap-3">
			<span className="font-mono tabular-nums">{label}</span>
			<span
				aria-hidden="true"
				className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"
			>
				<span
					className="block h-full rounded-full"
					style={{
						width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%`,
						background: "var(--viz-1)",
					}}
				/>
			</span>
		</span>
	);
}

// Missing values sort last whichever the direction.
const numeric = { sortFn: "basic" as const, sortUndefined: "last" as const };

const columns: ColumnDef<typeof features, OverviewNode>[] = [
	{
		id: "node",
		accessorFn: (node) => node.hostname ?? node.id,
		sortFn: "text",
		header: ({ column }) => (
			<SortableHeader label={m.overview_node()} column={column} />
		),
		cell: ({ row }) => (
			<span className="font-medium" title={row.original.id}>
				{row.original.hostname ?? row.original.id}
			</span>
		),
	},
	{
		id: "cpu",
		accessorFn: (node) => node.values.cpu ?? undefined,
		...numeric,
		meta: NUMERIC,
		header: ({ column }) => (
			<SortableHeader label={m.stat_cpu()} column={column} />
		),
		cell: ({ row, table }) => (
			<SectionCell section="cpu" table={table}>
				<Meter
					value={row.original.values.cpu ?? null}
					label={formatStat(
						"cpu",
						row.original.values.cpu ?? null,
						localeOf(table),
					)}
				/>
			</SectionCell>
		),
	},
	{
		id: "memory",
		accessorFn: (node) => node.values.memory ?? undefined,
		...numeric,
		meta: NUMERIC,
		header: ({ column }) => (
			<SortableHeader label={m.stat_memory()} column={column} />
		),
		cell: ({ row, table }) => (
			<SectionCell section="memory" table={table}>
				<Meter
					value={row.original.values.memory ?? null}
					label={formatStat(
						"memory",
						row.original.values.memory ?? null,
						localeOf(table),
					)}
				/>
			</SectionCell>
		),
	},
	{
		id: "memoryTotal",
		accessorFn: (node) => node.values.memoryTotal ?? undefined,
		...numeric,
		meta: { className: "text-right font-mono tabular-nums" },
		header: ({ column }) => (
			<SortableHeader label={m.overview_memory_total()} column={column} />
		),
		cell: ({ row, table }) => (
			<SectionCell section="memory" table={table}>
				{row.original.values.memoryTotal == null
					? "—"
					: formatMeasurement(
							row.original.values.memoryTotal,
							"By",
							localeOf(table),
						).text}
			</SectionCell>
		),
	},
	{
		id: "processes",
		accessorFn: (node) => node.values.processes ?? undefined,
		...numeric,
		meta: { className: "text-right font-mono tabular-nums" },
		header: ({ column }) => (
			<SortableHeader label={m.stat_processes()} column={column} />
		),
		cell: ({ row, table }) => (
			<SectionCell section="processes" table={table}>
				{formatStat(
					"processes",
					row.original.values.processes ?? null,
					localeOf(table),
				)}
			</SectionCell>
		),
	},
];

/** Each node's latest usage, sortable to find the busiest one. */
export function NodesTable({
	nodes,
	pending,
	loading,
	locale,
}: {
	nodes: OverviewNode[];
	/** Sections whose columns are still loading. */
	pending: ReadonlySet<OverviewSection>;
	loading: boolean;
	locale: string;
}) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const table = useTable({
		features,
		data: nodes,
		columns,
		meta: { locale, pending } satisfies Meta,
		getRowId: (node) => node.id,
		state: { sorting },
		onSortingChange: setSorting,
	});
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<h2 className="text-base font-semibold">{m.overview_nodes()}</h2>
				<p className="text-sm text-muted-foreground">
					{m.overview_nodes_description()}
				</p>
			</div>
			<div className="relative">
				<LoadingBar active={loading} className="rounded-t-md" />
				<DataTable
					table={table}
					label={m.overview_nodes()}
					empty={pending.size > 0 && <PendingRows />}
				/>
			</div>
		</div>
	);
}

/** Stands in for the rows until the first section names the nodes. */
function PendingRows() {
	return (
		<div className="flex flex-col gap-3 py-1">
			{["first", "second", "third"].map((row) => (
				<Skeleton key={row} className="h-4 w-full" />
			))}
		</div>
	);
}
