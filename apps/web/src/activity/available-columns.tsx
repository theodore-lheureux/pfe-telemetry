import { m } from "@recount/i18n/messages";
import { useState } from "react";
import { AttributeList } from "../analytics/attribute-list";
import type { AttributeDefinition } from "../analytics/contracts";
import { attributeField, isFieldKey } from "../analytics/fields";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../components/ui/select";
import {
	type ColumnCategory,
	columnCategory,
	columnName,
} from "./column-names";
import {
	BUILT_IN_COLUMNS,
	isBuiltIn,
	MAX_ATTRIBUTE_COLUMNS,
	MAX_COLUMNS,
} from "./columns";

type Category = "all" | ColumnCategory;
const CATEGORY_LABEL: Record<Category, () => string> = {
	all: m.columns_category_all,
	fields: m.columns_category_fields,
	point: m.activity_attribute_point,
	resource: m.activity_attribute_resource,
};

/** Fields not shown yet, searchable and grouped by category; choosing one adds it. */
export function AvailableColumns({
	attributes,
	visible,
	loading,
	onAdd,
}: {
	attributes: AttributeDefinition[] | undefined;
	visible: string[];
	loading: boolean;
	onAdd: (field: string) => void;
}) {
	const [category, setCategory] = useState<Category>("all");
	const shown = new Set(visible);
	const availableAttributes = (attributes ?? []).filter(
		(attribute) =>
			isFieldKey(attribute.key) &&
			attribute.status !== "hidden" &&
			!shown.has(attributeField(attribute.scope, attribute.key)),
	);
	const fields = [
		...BUILT_IN_COLUMNS,
		...new Set(
			availableAttributes.map((attribute) =>
				attributeField(attribute.scope, attribute.key),
			),
		),
	];
	const available = fields.filter((field) => !shown.has(field));
	const attributeCount = visible.filter((field) => !isBuiltIn(field)).length;
	const full = visible.length >= MAX_COLUMNS;
	const count = (option: Category) =>
		option === "all"
			? available.length
			: available.filter((field) => columnCategory(field) === option).length;
	return (
		<div className="space-y-2">
			{attributeCount >= MAX_ATTRIBUTE_COLUMNS && (
				<p className="pt-2 text-xs text-muted-foreground">
					{m.columns_attribute_limit({ count: MAX_ATTRIBUTE_COLUMNS })}
				</p>
			)}
			<AttributeList
				searchAction={
					<Select
						value={category}
						onValueChange={(value) => setCategory(value as Category)}
					>
						<SelectTrigger
							aria-label={m.columns_category()}
							className="h-full rounded-none border-0 bg-transparent pr-2.5 pl-1 text-foreground focus-visible:ring-inset dark:bg-transparent dark:hover:bg-transparent"
							// Keep category selection separate from cmdk's list navigation.
							onKeyDown={(event) => event.stopPropagation()}
						>
							<SelectValue>{CATEGORY_LABEL[category]()}</SelectValue>
						</SelectTrigger>
						<SelectContent
							position="popper"
							align="end"
							onKeyDown={(event) => event.stopPropagation()}
						>
							<SelectGroup>
								{(Object.keys(CATEGORY_LABEL) as Category[]).map((option) => (
									<SelectItem key={option} value={option}>
										{m.columns_category_count({
											category: CATEGORY_LABEL[option](),
											count: count(option),
										})}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				}
				outlined
				showPreview={false}
				searchPlaceholder={m.columns_search()}
				emptyMessage={m.columns_none()}
				attributes={availableAttributes.filter(
					(attribute) => category === "all" || category === attribute.scope,
				)}
				options={available
					.filter(
						(field) =>
							isBuiltIn(field) && (category === "all" || category === "fields"),
					)
					.map((field) => ({ value: field, label: columnName(field) }))}
				optionsHeading={m.columns_category_fields()}
				loading={loading}
				isDisabled={(field) =>
					full || (!isBuiltIn(field) && attributeCount >= MAX_ATTRIBUTE_COLUMNS)
				}
				onSelect={onAdd}
			/>
		</div>
	);
}
