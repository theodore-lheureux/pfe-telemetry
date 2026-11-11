import { m } from "@recount/i18n/messages";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../components/ui/command";
import { Label } from "../components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "../components/ui/native-select";
import {
	type ColumnCategory,
	columnCategory,
	columnKey,
	columnName,
} from "./column-names";
import { isBuiltIn, MAX_ATTRIBUTE_COLUMNS, MAX_COLUMNS } from "./columns";

type Category = "all" | ColumnCategory;
const CATEGORY_LABEL: Record<Category, () => string> = {
	all: m.columns_category_all,
	fields: m.columns_category_fields,
	point: m.activity_attribute_point,
	resource: m.activity_attribute_resource,
};
const CATEGORIES: ColumnCategory[] = ["fields", "point", "resource"];

/** Fields not shown yet, searchable and grouped by category; choosing one adds it. */
export function AvailableColumns({
	fields,
	visible,
	loading,
	onAdd,
}: {
	/** Every field that can be a column, in display order. */
	fields: string[];
	visible: string[];
	loading: boolean;
	onAdd: (field: string) => void;
}) {
	const id = useId();
	const [category, setCategory] = useState<Category>("all");
	const shown = new Set(visible);
	const available = fields.filter((field) => !shown.has(field));
	const attributeCount = visible.filter((field) => !isBuiltIn(field)).length;
	const full = visible.length >= MAX_COLUMNS;
	const count = (option: Category) =>
		option === "all"
			? available.length
			: available.filter((field) => columnCategory(field) === option).length;
	return (
		<Command className="bg-transparent p-0">
			<div className="flex items-center gap-2 [&>[data-slot=command-input-wrapper]]:flex-1 [&>[data-slot=command-input-wrapper]]:p-0">
				<CommandInput placeholder={m.columns_search()} />
				<Label htmlFor={`${id}-category`} className="sr-only">
					{m.columns_category()}
				</Label>
				<NativeSelect
					id={`${id}-category`}
					value={category}
					onChange={(event) => setCategory(event.target.value as Category)}
				>
					{(Object.keys(CATEGORY_LABEL) as Category[]).map((option) => (
						<NativeSelectOption key={option} value={option}>
							{m.columns_category_count({
								category: CATEGORY_LABEL[option](),
								count: count(option),
							})}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			{attributeCount >= MAX_ATTRIBUTE_COLUMNS && (
				<p className="pt-2 text-xs text-muted-foreground">
					{m.columns_attribute_limit({ count: MAX_ATTRIBUTE_COLUMNS })}
				</p>
			)}
			{/* The dialog body scrolls, so the list grows instead of scrolling itself. */}
			<CommandList className="max-h-none overflow-visible">
				<CommandEmpty>
					{loading ? m.activity_attribute_loading() : m.columns_none()}
				</CommandEmpty>
				{CATEGORIES.filter(
					(option) => category === "all" || category === option,
				).map((option) => {
					const items = available.filter(
						(field) => columnCategory(field) === option,
					);
					return items.length ? (
						<CommandGroup key={option} heading={CATEGORY_LABEL[option]()}>
							{items.map((field) => (
								<CommandItem
									key={field}
									value={field}
									keywords={[columnName(field), columnKey(field)]}
									disabled={
										full ||
										(!isBuiltIn(field) &&
											attributeCount >= MAX_ATTRIBUTE_COLUMNS)
									}
									onSelect={() => onAdd(field)}
								>
									<PlusIcon
										aria-hidden="true"
										className="text-muted-foreground"
									/>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate">{columnName(field)}</span>
										{columnName(field) !== columnKey(field) && (
											<span className="truncate font-mono text-[11px] text-muted-foreground">
												{columnKey(field)}
											</span>
										)}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					) : null;
				})}
			</CommandList>
		</Command>
	);
}
