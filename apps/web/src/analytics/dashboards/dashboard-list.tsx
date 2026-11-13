import { m } from "@recount/i18n/messages";
import { Link, useHydrated } from "@tanstack/react-router";
import {
	type ColumnDef,
	type ColumnFiltersState,
	columnFilteringFeature,
	createFilteredRowModel,
	createSortedRowModel,
	rowSortingFeature,
	type SortingState,
	sortFn_alphanumeric,
	sortFn_datetime,
	sortFn_text,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import { PanelsTopLeftIcon, PlusIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { DataTable, SortableHeader } from "../../components/data-table";
import { FormFeedback } from "../../components/form-feedback";
import { TimeDisplay } from "../../components/time-display";
import { Button } from "../../components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "../../components/ui/input-group";
import { Label } from "../../components/ui/label";
import { IconEmptyState } from "../../components/workspace";
import type { ProjectReference } from "../../organizations/contracts";
import type { DashboardSummary } from "../dashboards";
import { InsightsHeader } from "../insights-header";
import { CreatorCell } from "../saved/saved-columns";
import { useDashboardActions } from "./dashboard-actions";

const features = tableFeatures({
	rowSortingFeature,
	columnFilteringFeature,
	sortedRowModel: createSortedRowModel(),
	filteredRowModel: createFilteredRowModel(),
	sortFns: {
		datetime: sortFn_datetime,
		text: sortFn_text,
		number: sortFn_alphanumeric,
	},
});

interface Meta {
	userId: string;
	open: (dashboard: DashboardSummary) => ReactNode;
	menu: (dashboard: DashboardSummary) => ReactNode;
}
const meta = (table: { options: { meta?: unknown } }) =>
	table.options.meta as Meta;

const columns: ColumnDef<typeof features, DashboardSummary>[] = [
	{
		id: "name",
		accessorFn: (row) => row.name,
		sortFn: "text",
		filterFn: (row, _id, value: string) =>
			`${row.original.name} ${row.original.description}`
				.toLocaleLowerCase()
				.includes(value.toLocaleLowerCase()),
		header: ({ column }) => <SortableHeader label={m.name()} column={column} />,
		cell: ({ row, table }) => (
			<div className="flex min-w-0 items-start gap-3">
				<PanelsTopLeftIcon
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-primary"
				/>
				<div className="min-w-0">
					{meta(table).open(row.original)}
					{row.original.description && (
						<p className="line-clamp-2 text-xs whitespace-normal text-muted-foreground">
							{row.original.description}
						</p>
					)}
				</div>
			</div>
		),
	},
	{
		id: "tiles",
		meta: { className: "w-28" },
		accessorFn: (row) => row.tileCount,
		sortFn: "number",
		header: ({ column }) => (
			<SortableHeader label={m.dashboard_insights()} column={column} />
		),
		cell: ({ row }) => (
			<span className="text-muted-foreground tabular-nums">
				{row.original.tileCount}
			</span>
		),
	},
	{
		id: "createdBy",
		meta: { className: "w-48" },
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
			<span className="relative z-10 text-muted-foreground">
				<TimeDisplay value={row.original.updatedAt} mode="relative" />
			</span>
		),
	},
	{
		id: "actions",
		meta: { className: "w-12 text-right" },
		enableSorting: false,
		header: () => <span className="sr-only">{m.actions()}</span>,
		cell: ({ row, table }) => (
			<span className="relative z-10">{meta(table).menu(row.original)}</span>
		),
	},
];

/** The project's dashboards, searchable and sortable, with a button to make one. */
export function DashboardList({
	userId,
	reference,
	canWrite,
	dashboards,
}: {
	userId: string;
	reference: ProjectReference;
	canWrite: boolean;
	dashboards: DashboardSummary[];
}) {
	const id = useId();
	const hydrated = useHydrated();
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "updatedAt", desc: true },
	]);
	const [filters, setFilters] = useState<ColumnFiltersState>([]);
	const actions = useDashboardActions(userId, reference, canWrite);
	const table = useTable({
		features,
		data: dashboards,
		columns,
		meta: {
			userId,
			menu: actions.menu,
			open: (dashboard) => (
				<Link
					to="/organizations/$organizationId/projects/$projectId/insights/dashboards/$dashboardId"
					params={{ ...reference, dashboardId: dashboard.id }}
					// Covers the row, so clicking anywhere on it opens the dashboard.
					className="font-medium after:absolute after:inset-0 hover:underline"
				>
					{dashboard.name}
				</Link>
			),
		} satisfies Meta,
		getRowId: (row) => row.id,
		state: { sorting, columnFilters: filters },
		onSortingChange: setSorting,
		onColumnFiltersChange: setFilters,
	});
	const search = (filters.find((filter) => filter.id === "name")?.value ??
		"") as string;
	const create = canWrite && (
		<Button disabled={!hydrated} onClick={actions.create}>
			<PlusIcon aria-hidden="true" />
			{m.dashboard_new()}
		</Button>
	);
	return (
		<section className="flex min-w-0 flex-col gap-5">
			<InsightsHeader tab="dashboards" reference={reference} />
			{dashboards.length === 0 ? (
				<IconEmptyState
					icon={<PanelsTopLeftIcon aria-hidden="true" />}
					title={m.dashboard_list_empty()}
					description={m.dashboard_list_empty_description()}
					className="bg-card"
				>
					{create}
				</IconEmptyState>
			) : (
				<>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="w-full max-w-sm">
							<Label htmlFor={`${id}-search`} className="sr-only">
								{m.dashboard_search()}
							</Label>
							<InputGroup>
								<InputGroupAddon>
									<SearchIcon aria-hidden="true" />
								</InputGroupAddon>
								<InputGroupInput
									id={`${id}-search`}
									type="search"
									value={search}
									placeholder={m.dashboard_search()}
									onChange={(event) =>
										setFilters(
											event.target.value
												? [{ id: "name", value: event.target.value }]
												: [],
										)
									}
								/>
							</InputGroup>
						</div>
						{create}
					</div>
					<FormFeedback
						message={actions.error}
						kind="error"
						reserveLine={false}
					/>
					<DataTable
						table={table}
						label={m.dashboards()}
						empty={m.dashboard_no_match()}
					/>
				</>
			)}
			{actions.dialogs}
		</section>
	);
}
