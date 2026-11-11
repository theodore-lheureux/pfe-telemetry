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
								aria-sort={
									sorted === "asc"
										? "ascending"
										: sorted === "desc"
											? "descending"
											: "none"
								}
							>
								{header.column.getCanSort() ? (
									<button
										type="button"
										disabled={!hydrated}
										className="-ml-2 inline-flex h-7 items-center gap-1 rounded-md px-2 font-semibold uppercase tracking-wide hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
										aria-label={m.settings_sort_by({ column: label })}
										onClick={header.column.getToggleSortingHandler()}
									>
										<table.FlexRender header={header} />
										<Icon aria-hidden="true" className="size-3.5" />
									</button>
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
