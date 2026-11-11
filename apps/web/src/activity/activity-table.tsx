import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import type { ColumnDef } from "@tanstack/react-table";
import { useTable } from "@tanstack/react-table";
import {
	type CSSProperties,
	Fragment,
	type PointerEventHandler,
	type ReactNode,
	useMemo,
} from "react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui/table";
import { cn } from "../lib/utils";
import { type ActivityRow, activityFeatures } from "./activity-columns";

/**
 * Compact activity rows with day separators, an inline inspector under expanded rows,
 * and loading and empty states that span the table.
 */
export function ActivityTable({
	label,
	rows,
	columns,
	hydrated,
	expanded,
	selectedId,
	refreshing,
	pending,
	empty,
	isNew,
	inspector,
	onInspect,
	onPointerEnter,
	onPointerLeave,
}: {
	label: string;
	rows: ActivityRow[];
	columns: ColumnDef<typeof activityFeatures, ActivityRow>[];
	hydrated: boolean;
	expanded: Set<string>;
	selectedId?: string;
	refreshing: boolean;
	pending: boolean;
	/** Shown in place of rows when there are none. */
	empty: ReactNode;
	/** Rows that arrived with the latest reload are highlighted. */
	isNew: (id: string) => boolean;
	inspector: (row: ActivityRow) => ReactNode;
	onInspect: (row: ActivityRow) => void;
	onPointerEnter?: PointerEventHandler;
	onPointerLeave?: PointerEventHandler;
}) {
	const table = useTable({
		features: activityFeatures,
		data: rows,
		columns,
		getRowId: (row) => row.id,
	});
	const days = useMemo(
		() => new Intl.DateTimeFormat(getLocale(), { dateStyle: "long" }),
		[],
	);
	const columnCount = table.getVisibleLeafColumns().length;
	// Day separators use the browser's calendar day, so they render after hydration.
	const today = hydrated ? days.format(new Date()) : null;
	const dayOf = (row: ActivityRow) => {
		const value = row.point?.measuredAt ?? row.packet?.receivedAt;
		return today && value ? days.format(value) : null;
	};
	const spanning = (content: ReactNode, className?: string) => (
		<TableRow className="hover:bg-transparent">
			<TableCell colSpan={columnCount} className={className}>
				{content}
			</TableCell>
		</TableRow>
	);
	return (
		<div
			aria-busy={refreshing}
			className="relative overflow-hidden rounded-md border bg-card"
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			style={
				// Tide derives cell padding from the unit padding; keep rows compact.
				{ "--control-height": "28px", "--unit-padding": "8px" } as CSSProperties
			}
		>
			{refreshing && (
				<div
					aria-hidden="true"
					className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-primary/15"
				>
					<div className="h-full w-1/3 animate-[navigation-progress_1.1s_ease-in-out_infinite] bg-primary motion-reduce:w-full motion-reduce:animate-none" />
				</div>
			)}
			<Table className="text-[13px] leading-5" aria-label={label}>
				<TableHeader>
					{table.getHeaderGroups().map((group) => (
						<TableRow key={group.id} className="hover:bg-transparent">
							{group.headers.map((header) => (
								<TableHead
									key={header.id}
									className={
										header.column.id === "expand" ? "w-10 pr-1 pl-3" : undefined
									}
								>
									<table.FlexRender header={header} />
								</TableHead>
							))}
						</TableRow>
					))}
				</TableHeader>
				<TableBody>
					{table.getRowModel().rows.map((row, index, all) => {
						const day = dayOf(row.original);
						const previous = index ? dayOf(all[index - 1].original) : today;
						return (
							<Fragment key={row.id}>
								{day &&
									day !== previous &&
									spanning(
										day,
										"bg-muted/40 py-1.5 text-center text-xs font-medium text-muted-foreground",
									)}
								<TableRow
									className={cn(
										"h-8 cursor-pointer",
										isNew(row.id) &&
											"motion-safe:animate-[row-arrival_2s_ease-out]",
										(expanded.has(row.id) || selectedId === row.id) &&
											"bg-muted/40",
									)}
									style={{ "--control-height": "24px" } as CSSProperties}
									onClick={() => hydrated && onInspect(row.original)}
								>
									{row.getVisibleCells().map((cell) => (
										<TableCell
											key={cell.id}
											className={
												cell.column.id === "expand"
													? "py-0.5 pr-1 pl-3"
													: "py-1"
											}
										>
											<table.FlexRender cell={cell} />
										</TableCell>
									))}
								</TableRow>
								{expanded.has(row.id) && (
									<TableRow
										id={`activity-${row.id}`}
										className="hover:bg-transparent"
									>
										<TableCell
											colSpan={columnCount}
											className="whitespace-normal bg-muted/20 p-0"
										>
											{inspector(row.original)}
										</TableCell>
									</TableRow>
								)}
							</Fragment>
						);
					})}
					{pending && (
						<TableRow className="hover:bg-transparent">
							<TableCell
								colSpan={columnCount}
								className="p-10 text-center text-muted-foreground"
								role="status"
							>
								{m.activity_loading()}
							</TableCell>
						</TableRow>
					)}
					{empty && spanning(empty, "whitespace-normal")}
				</TableBody>
			</Table>
		</div>
	);
}
