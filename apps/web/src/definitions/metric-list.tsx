import { m } from "@recount/i18n/messages";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { ChartLineIcon, CircleDotIcon } from "lucide-react";
import { useState } from "react";
import { FacetFilter } from "../analytics/saved/facet-filter";
import { UserAvatar } from "../components/identity-avatar";
import { SearchField } from "../components/search-field";
import { IconEmptyState } from "../components/workspace";
import type { ProjectReference } from "../organizations/contracts";
import type { MetricEntry } from "./contracts";
import { DefinitionsHeader } from "./definitions-header";
import { STATUS, STATUS_CHOICES } from "./labels";
import { MetricTable } from "./metric-table";

/** All project metrics in one searchable, filterable table. */
export function MetricList({
	userId,
	reference,
	metrics,
}: {
	userId: string;
	reference: ProjectReference;
	metrics: MetricEntry[];
}) {
	const [filters, setFilters] = useState<ColumnFiltersState>([]);
	const filterValue = <T,>(column: string, fallback: T) =>
		(filters.find((filter) => filter.id === column)?.value as T) ?? fallback;
	const setFilter = (column: string, value: string | string[]) =>
		setFilters((current) => [
			...current.filter((filter) => filter.id !== column),
			...(value.length ? [{ id: column, value }] : []),
		]);
	const owners = [
		...new Map(
			metrics.flatMap((metric) =>
				metric.owner ? [[metric.owner.id, metric.owner] as const] : [],
			),
		).values(),
	];
	const tags = [
		...new Map(
			metrics
				.flatMap((metric) => metric.tags)
				.map((tag) => [tag.toLowerCase(), tag]),
		).values(),
	].sort((a, b) => a.localeCompare(b));

	return (
		<section className="flex min-w-0 flex-col gap-5">
			<DefinitionsHeader tab="metrics" reference={reference} />
			<div className="flex flex-wrap items-center justify-between gap-3">
				<SearchField
					label={m.definitions_search_metrics()}
					value={filterValue("name", "")}
					onChange={(value) => setFilter("name", value)}
				/>
				<div className="flex flex-wrap items-center gap-2">
					<FacetFilter
						label={m.definitions_status()}
						icon={<CircleDotIcon aria-hidden="true" />}
						selected={filterValue<string[]>("status", [])}
						onChange={(value) => setFilter("status", value)}
						options={STATUS_CHOICES.map((status) => ({
							value: status,
							label: STATUS[status].label(),
						}))}
					/>
					{owners.length > 0 && (
						<FacetFilter
							label={m.definitions_owner()}
							searchable
							selected={filterValue<string[]>("owner", [])}
							onChange={(value) => setFilter("owner", value)}
							options={owners.map((owner) => ({
								value: owner.id,
								label: owner.name || owner.email,
								leading: <UserAvatar user={owner} className="size-5" />,
							}))}
						/>
					)}
					{tags.length > 0 && (
						<FacetFilter
							label={m.tags()}
							searchable
							selected={filterValue<string[]>("tags", [])}
							onChange={(value) => setFilter("tags", value)}
							options={tags.map((tag) => ({ value: tag, label: tag }))}
						/>
					)}
				</div>
			</div>
			{metrics.length > 0 ? (
				<MetricTable
					userId={userId}
					reference={reference}
					metrics={metrics}
					label={m.definitions_metrics()}
					filters={filters}
				/>
			) : (
				<IconEmptyState
					icon={<ChartLineIcon aria-hidden="true" />}
					title={m.definitions_empty_metrics()}
					description={m.definitions_empty_metrics_description()}
					className="bg-card"
				/>
			)}
		</section>
	);
}
