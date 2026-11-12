import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import {
	type ColumnFiltersState,
	type RowSelectionState,
	type SortingState,
	useTable,
} from "@tanstack/react-table";
import {
	BookmarkIcon,
	LayoutGridIcon,
	SearchIcon,
	Trash2Icon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { DataTable } from "../../components/data-table";
import { FormFeedback } from "../../components/form-feedback";
import { UserAvatar } from "../../components/identity-avatar";
import { Button } from "../../components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "../../components/ui/input-group";
import { Label } from "../../components/ui/label";
import { IconEmptyState } from "../../components/workspace";
import type { ProjectReference } from "../../organizations/contracts";
import { decodeDraft } from "../insight/draft";
import { DISPLAY_ICON, DISPLAY_LABEL } from "../insight/labels";
import { InsightsHeader } from "../insights-header";
import type { InsightPerson, SavedInsight } from "../saved-insights";
import { FacetFilter } from "./facet-filter";
import { useInsightActions } from "./insight-actions";
import {
	type SavedRow,
	type SavedTableMeta,
	savedColumns,
	savedFeatures,
} from "./saved-columns";
import { TagUpdate } from "./tag-update";

const EXPLORE =
	"/organizations/$organizationId/projects/$projectId/insights/explore" as const;

/**
 * The project's saved insights: searchable, filterable by chart type and creator,
 * sortable, and selectable for deletion.
 */
export function SavedInsights({
	userId,
	reference,
	canWrite,
	insights,
}: {
	userId: string;
	reference: ProjectReference;
	canWrite: boolean;
	insights: SavedInsight[];
}) {
	const id = useId();
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "updatedAt", desc: true },
	]);
	const [filters, setFilters] = useState<ColumnFiltersState>([]);
	const [selection, setSelection] = useState<RowSelectionState>({});
	const actions = useInsightActions(userId, reference, canWrite, () =>
		setSelection({}),
	);
	const rows = useMemo<SavedRow[]>(
		() =>
			insights.map((insight) => ({
				insight,
				draft: decodeDraft(insight.draft),
			})),
		[insights],
	);
	const filterValue = <T,>(column: string, fallback: T) =>
		(filters.find((filter) => filter.id === column)?.value as T) ?? fallback;
	const setFilter = (column: string, value: string | string[]) =>
		setFilters((current) => [
			...current.filter((filter) => filter.id !== column),
			...(value.length ? [{ id: column, value }] : []),
		]);
	const meta: SavedTableMeta = {
		userId,
		canWrite,
		open: (insight) => (
			<Link
				to={EXPLORE}
				params={reference}
				search={{ insight: insight.id }}
				className="font-medium hover:underline"
			>
				{insight.name}
			</Link>
		),
		menu: actions.menu,
	};
	const table = useTable({
		features: savedFeatures,
		data: rows,
		columns: savedColumns,
		meta,
		getRowId: (row) => row.insight.id,
		state: {
			sorting,
			columnFilters: filters,
			rowSelection: selection,
			columnVisibility: { type: false },
		},
		onSortingChange: setSorting,
		onColumnFiltersChange: setFilters,
		onRowSelectionChange: setSelection,
	});

	if (insights.length === 0)
		return (
			<section className="flex min-w-0 flex-col gap-5">
				<InsightsHeader tab="saved" reference={reference} />
				<IconEmptyState
					icon={<BookmarkIcon aria-hidden="true" />}
					title={m.saved_empty()}
					description={m.saved_empty_description()}
					className="bg-card"
				>
					<Button asChild variant="outline">
						<Link to={EXPLORE} params={reference}>
							{m.saved_explore()}
						</Link>
					</Button>
				</IconEmptyState>
			</section>
		);

	// Filter choices come from the insights that exist, so none leads nowhere.
	const types = [...new Set(rows.map((row) => row.draft.display.type))];
	const people = new Map<string, InsightPerson>();
	for (const insight of insights)
		if (insight.createdBy) people.set(insight.createdBy.id, insight.createdBy);
	// The current user comes first, then everyone else by name.
	const creators = [...people.values()].sort(
		(a, b) =>
			Number(b.id === userId) - Number(a.id === userId) ||
			a.name.localeCompare(b.name),
	);
	const allTags = [
		...new Map(
			insights
				.flatMap((insight) => insight.tags)
				.map((tag) => [tag.toLowerCase(), tag]),
		).values(),
	].sort((a, b) => a.localeCompare(b));
	const selected = table
		.getSelectedRowModel()
		.rows.map((row) => row.original.insight);

	return (
		<section className="flex min-w-0 flex-col gap-5">
			<InsightsHeader tab="saved" reference={reference} />
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="w-full max-w-sm">
					<Label htmlFor={`${id}-search`} className="sr-only">
						{m.saved_search()}
					</Label>
					<InputGroup>
						<InputGroupAddon>
							<SearchIcon aria-hidden="true" />
						</InputGroupAddon>
						<InputGroupInput
							id={`${id}-search`}
							type="search"
							value={filterValue("name", "")}
							placeholder={m.saved_search()}
							onChange={(event) => setFilter("name", event.target.value)}
						/>
					</InputGroup>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<FacetFilter
						label={m.saved_all_types()}
						icon={<LayoutGridIcon aria-hidden="true" />}
						selected={filterValue<string[]>("type", [])}
						onChange={(value) => setFilter("type", value)}
						options={types.map((type) => {
							const Icon = DISPLAY_ICON[type];
							return {
								value: type,
								label: DISPLAY_LABEL[type](),
								leading: <Icon aria-hidden="true" />,
							};
						})}
					/>
					<FacetFilter
						label={m.tags()}
						searchable
						selected={filterValue<string[]>("tags", [])}
						onChange={(value) => setFilter("tags", value)}
						options={allTags.map((tag) => ({ value: tag, label: tag }))}
					/>
					<FacetFilter
						label={m.saved_created_by()}
						searchable
						selected={filterValue<string[]>("createdBy", [])}
						onChange={(value) => setFilter("createdBy", value)}
						options={creators.map((person) => ({
							value: person.id,
							label: person.name || person.email,
							leading: <UserAvatar user={person} className="size-5" />,
							note: person.id === userId ? m.saved_you_note() : undefined,
						}))}
					/>
				</div>
			</div>
			{selected.length > 0 && (
				<div className="flex flex-wrap items-center justify-end gap-2">
					<span className="text-sm text-muted-foreground">
						{selected.length === 1
							? m.saved_selected_one()
							: m.saved_selected_many({ count: selected.length })}
					</span>
					<Button variant="outline" onClick={() => setSelection({})}>
						{m.saved_clear()}
					</Button>
					<TagUpdate
						userId={userId}
						reference={reference}
						insights={selected}
						suggestions={allTags}
						onUpdated={() => setSelection({})}
					/>
					<Button
						variant="destructive"
						onClick={() => actions.confirmDelete(selected)}
					>
						<Trash2Icon aria-hidden="true" />
						{m.saved_delete_selected()}
					</Button>
				</div>
			)}
			<FormFeedback message={actions.error} kind="error" reserveLine={false} />
			<DataTable
				table={table}
				label={m.insight_tab_saved()}
				empty={m.saved_no_match()}
			/>
			{actions.dialogs}
		</section>
	);
}
