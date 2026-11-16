import { m } from "@recount/i18n/messages";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { TagIcon } from "lucide-react";
import { useState } from "react";
import { FacetFilter } from "../analytics/saved/facet-filter";
import { SearchField } from "../components/search-field";
import { IconEmptyState } from "../components/workspace";
import type { ProjectReference } from "../organizations/contracts";
import { SCOPE_LABEL } from "./attribute-columns";
import { AttributeTable } from "./attribute-table";
import {
	ATTRIBUTE_SCOPES,
	type AttributeEntry,
	type AttributeScope,
} from "./contracts";
import { DefinitionsHeader } from "./definitions-header";

/** Attribute keys collected metrics carry, searchable and filterable by what they describe. */
export function AttributeList({
	reference,
	attributes,
}: {
	reference: ProjectReference;
	attributes: AttributeEntry[];
}) {
	const [scopes, setScopes] = useState<AttributeScope[]>([]);
	const [search, setSearch] = useState("");
	const filters: ColumnFiltersState = [
		...(scopes.length ? [{ id: "scope", value: scopes }] : []),
		...(search ? [{ id: "key", value: search }] : []),
	];
	return (
		<section className="flex min-w-0 flex-col gap-5">
			<DefinitionsHeader tab="attributes" reference={reference} />
			{attributes.length === 0 ? (
				<IconEmptyState
					icon={<TagIcon aria-hidden="true" />}
					title={m.definitions_empty_attributes()}
					description={m.definitions_empty_attributes_description()}
					className="bg-card"
				/>
			) : (
				<>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<SearchField
							label={m.definitions_search_attributes()}
							value={search}
							onChange={setSearch}
						/>
						<FacetFilter
							label={m.definitions_scope()}
							selected={scopes}
							onChange={(value) => setScopes(value as AttributeScope[])}
							options={ATTRIBUTE_SCOPES.map((entry) => ({
								value: entry,
								label: SCOPE_LABEL[entry](),
							}))}
						/>
					</div>
					<AttributeTable
						reference={reference}
						attributes={attributes}
						label={m.definitions_attributes()}
						columns={{ example: false }}
						filters={filters}
					/>
				</>
			)}
		</section>
	);
}
