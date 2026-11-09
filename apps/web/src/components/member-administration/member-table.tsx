import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import {
	columnFilteringFeature,
	createFilteredRowModel,
	createSortedRowModel,
	filterFn_includesString,
	globalFilteringFeature,
	type ReactTable,
	type RowData,
	rowSortingFeature,
	sortFns,
	tableFeatures,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowDownUpIcon, ArrowUpIcon } from "lucide-react";
import { Button } from "../ui/button";
import { TableHead, TableHeader, TableRow } from "../ui/table";

export const memberTableFeatures = tableFeatures({
	columnFilteringFeature,
	globalFilteringFeature,
	filteredRowModel: createFilteredRowModel(),
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	sortFns,
	filterFns: { includesString: filterFn_includesString },
});

export function MemberTableHeader<T extends RowData>({
	table,
}: {
	table: ReactTable<typeof memberTableFeatures, T>;
}) {
	const hydrated = useHydrated();
	return (
		<TableHeader>
			{table.getHeaderGroups().map((group) => (
				<TableRow key={group.id}>
					{group.headers.map((header) => {
						const sorted = header.column.getIsSorted();
						const Icon =
							sorted === "asc"
								? ArrowUpIcon
								: sorted === "desc"
									? ArrowDownIcon
									: ArrowDownUpIcon;
						const label =
							typeof header.column.columnDef.header === "string"
								? header.column.columnDef.header
								: m.actions();
						return (
							<TableHead
								key={header.id}
								className="text-[11px] font-semibold uppercase tracking-wide"
								aria-sort={
									sorted === "asc"
										? "ascending"
										: sorted === "desc"
											? "descending"
											: "none"
								}
							>
								{header.column.getCanSort() ? (
									<Button
										variant="ghost"
										disabled={!hydrated}
										size="sm"
										className="-ml-2 text-[11px] uppercase"
										aria-label={m.settings_sort_by({ column: label })}
										onClick={header.column.getToggleSortingHandler()}
									>
										<table.FlexRender header={header} />
										<Icon aria-hidden="true" className="size-3.5" />
									</Button>
								) : (
									<table.FlexRender header={header} />
								)}
							</TableHead>
						);
					})}
				</TableRow>
			))}
		</TableHeader>
	);
}
