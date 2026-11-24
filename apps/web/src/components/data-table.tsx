import type {
	Cell,
	ReactTable,
	RowData,
	TableFeatures,
} from "@tanstack/react-table";
import { cn } from "cn";
import {
	ArrowDownIcon,
	ArrowUpDownIcon,
	ArrowUpIcon,
	ChevronRightIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { Button } from "./ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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
	expanded,
	collapse,
	className,
	embedded = false,
	onRowHover,
}: {
	table: ReactTable<TFeatures, TData>;
	label: string;
	/** Shown across the table when it has no rows. */
	empty?: ReactNode;
	/** Content shown under a row across every column, or nothing while it is collapsed. */
	expanded?: (row: TData) => ReactNode;
	/** Rows that `match` move to the end, behind one row that shows or hides them. */
	collapse?: {
		match: (row: TData) => boolean;
		label: (count: number) => ReactNode;
	};
	className?: string;
	/** Use the parent card's frame and scroll within its available height. */
	embedded?: boolean;
	onRowHover?: (row: TData | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const all = table.getRowModel().rows;
	const tail = collapse
		? all.filter((row) => collapse.match(row.original))
		: [];
	const rows = tail.length
		? all.filter((row) => !collapse?.match(row.original))
		: all;
	const columnCount = table.getHeaderGroups()[0]?.headers.length ?? 1;
	return (
		<div
			className={cn(
				"bg-card text-card-foreground",
				embedded
					? "min-h-0 flex-1 overflow-hidden [&>[data-slot=table-container]]:h-full [&>[data-slot=table-container]]:overflow-auto [&_td]:px-3 [&_th]:px-3"
					: "rounded-md border",
				className,
			)}
		>
			<Table aria-label={label}>
				<TableHeader className={cn(embedded && "sticky top-0 z-10 bg-card")}>
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
					{[...rows, ...(open ? tail : [])].map((row, index) => {
						const detail = expanded?.(row.original);
						return (
							<Fragment key={row.id}>
								{collapse && index === rows.length && (
									<CollapseRow
										open
										columns={columnCount}
										onToggle={() => setOpen(false)}
									>
										{collapse.label(tail.length)}
									</CollapseRow>
								)}
								<TableRow
									// Lets a cell's link stretch over the whole row.
									className="relative"
									onMouseEnter={
										onRowHover ? () => onRowHover(row.original) : undefined
									}
									onMouseLeave={onRowHover ? () => onRowHover(null) : undefined}
									data-state={
										(row as Selectable).getIsSelected?.()
											? "selected"
											: undefined
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
								{detail && (
									<TableRow className="hover:bg-transparent">
										<TableCell colSpan={columnCount} className="p-4">
											{detail}
										</TableCell>
									</TableRow>
								)}
							</Fragment>
						);
					})}
					{collapse && tail.length > 0 && !open && (
						<CollapseRow
							open={false}
							columns={columnCount}
							onToggle={() => setOpen(true)}
						>
							{collapse.label(tail.length)}
						</CollapseRow>
					)}
					{all.length === 0 && empty && (
						<TableRow>
							<TableCell
								colSpan={columnCount}
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

function CollapseRow({
	open,
	columns,
	onToggle,
	children,
}: {
	open: boolean;
	columns: number;
	onToggle: () => void;
	children: ReactNode;
}) {
	return (
		<TableRow className="hover:bg-transparent">
			<TableCell colSpan={columns} className="py-1">
				<Button
					variant="ghost"
					size="sm"
					aria-expanded={open}
					className="-ml-2 text-muted-foreground"
					onClick={onToggle}
				>
					<ChevronRightIcon
						aria-hidden="true"
						className={cn("transition-transform", open && "rotate-90")}
					/>
					{children}
				</Button>
			</TableCell>
		</TableRow>
	);
}

// Headers sit flush with the table's scroll edge, so the focus ring is drawn inside.
const HEADER_CLASS =
	"-ml-2 h-7 px-2 text-xs font-semibold tracking-wide uppercase focus-visible:ring-inset";
const SORT_ICON = {
	asc: ArrowUpIcon,
	desc: ArrowDownIcon,
	none: ArrowUpDownIcon,
};

/** A column header that sorts its column, showing the direction when sorted. */
export function SortableHeader({
	label,
	column,
	className,
	showUnsorted = false,
	hint,
}: {
	label: string;
	/** Explains the column when its label is terse, shown on hover and focus. */
	hint?: string;
	column: {
		getIsSorted: () => false | "asc" | "desc";
		getToggleSortingHandler: () => undefined | ((event: unknown) => void);
	};
	className?: string;
	showUnsorted?: boolean;
}) {
	const sorted = column.getIsSorted();
	const Icon = SORT_ICON[sorted || "none"];
	const button = (
		<Button
			variant="ghost"
			size="sm"
			className={cn(HEADER_CLASS, className)}
			onClick={column.getToggleSortingHandler()}
		>
			{label}
			<Icon
				aria-hidden="true"
				className={cn("size-3.5", !sorted && !showUnsorted && "opacity-0")}
			/>
		</Button>
	);
	if (!hint) return button;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{button}</TooltipTrigger>
			<TooltipContent>{hint}</TooltipContent>
		</Tooltip>
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
