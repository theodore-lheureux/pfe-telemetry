import type {
	Cell,
	ReactTable,
	RowData,
	TableFeatures,
} from "@tanstack/react-table";
import { cn } from "cn";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table";

/** Column meta read by `DataTable`: classes for the column's cells, such as a width. */
export interface DataTableColumnMeta {
	className?: string;
}

// Sorting, selection and visibility are optional table features, so their APIs may be
// absent from a row or column.
type Sortable = { getIsSorted?: () => false | "asc" | "desc" };
type Selectable = { getIsSelected?: () => boolean };
type Visible<TFeatures extends TableFeatures, TData extends RowData> = {
	getVisibleCells?: () => Cell<TFeatures, TData, unknown>[];
};

function cellClass(column: { columnDef: { meta?: unknown } }) {
	return (column.columnDef.meta as DataTableColumnMeta | undefined)?.className;
}

function ariaSort(column: Sortable) {
	const sorted = column.getIsSorted?.();
	if (sorted === "asc") return "ascending";
	if (sorted === "desc") return "descending";
	return undefined;
}

/**
 * A TanStack table rendered with the shadcn table: header, rows and an optional row
 * shown when there are none. Columns set their cell classes through `meta.className`.
 */
export function DataTable<
	TFeatures extends TableFeatures,
	TData extends RowData,
>({
	table,
	label,
	empty,
	className,
}: {
	table: ReactTable<TFeatures, TData>;
	label: string;
	/** Shown across the table when it has no rows. */
	empty?: ReactNode;
	className?: string;
}) {
	const rows = table.getRowModel().rows;
	return (
		<div
			className={cn(
				"rounded-md border bg-card text-card-foreground",
				className,
			)}
		>
			<Table aria-label={label}>
				<TableHeader>
					{table.getHeaderGroups().map((group) => (
						<TableRow key={group.id}>
							{group.headers.map((header) => (
								<TableHead
									key={header.id}
									className={cellClass(header.column)}
									aria-sort={ariaSort(header.column as Sortable)}
								>
									<table.FlexRender header={header} />
								</TableHead>
							))}
						</TableRow>
					))}
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow
							key={row.id}
							data-state={
								(row as Selectable).getIsSelected?.() ? "selected" : undefined
							}
						>
							{(
								(row as Visible<TFeatures, TData>).getVisibleCells?.() ??
								row.getAllCells()
							).map((cell) => (
								<TableCell key={cell.id} className={cellClass(cell.column)}>
									<table.FlexRender cell={cell} />
								</TableCell>
							))}
						</TableRow>
					))}
					{rows.length === 0 && empty && (
						<TableRow>
							<TableCell
								colSpan={table.getHeaderGroups()[0]?.headers.length ?? 1}
								className="py-8 text-center text-muted-foreground"
							>
								{empty}
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
		</div>
	);
}

const HEADER_CLASS =
	"-ml-2 h-7 px-2 text-xs font-semibold tracking-wide uppercase";

/** A column header that sorts its column, showing the direction when sorted. */
export function SortableHeader({
	label,
	column,
	className,
}: {
	label: string;
	column: {
		getIsSorted: () => false | "asc" | "desc";
		getToggleSortingHandler: () => undefined | ((event: unknown) => void);
	};
	className?: string;
}) {
	const sorted = column.getIsSorted();
	const Icon = sorted === "asc" ? ArrowUpIcon : ArrowDownIcon;
	return (
		<Button
			variant="ghost"
			size="sm"
			className={cn(HEADER_CLASS, className)}
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

/** A header styled like the sortable ones, for columns that do not sort. */
export function PlainHeader({ label }: { label: string }) {
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
