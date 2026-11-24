import { m } from "@recount/i18n/messages";
import type { ReactNode } from "react";
import {
	CommandEmpty,
	CommandGroup,
	CommandItem,
} from "../components/ui/command";
import type { AttributeDefinition } from "./contracts";
import { DefinitionChoice } from "./definition-choice";
import { attributeLabel } from "./definition-labels";
import { attributeField, isFieldKey } from "./fields";
import {
	attributePreview,
	PickerCommand,
	type PickerPreview,
} from "./picker-command";

/** A choice listed above the attributes, such as a core field. */
export interface ListOption {
	value: string;
	label: string;
}

/**
 * Discovered attributes, searchable and grouped into point and resource attributes,
 * as Explorer's filters list them. Options, such as core fields, can come first.
 */
export function AttributeList({
	attributes,
	loading,
	options = [],
	optionsHeading,
	selected,
	isDisabled,
	searchPlaceholder = m.activity_attribute_search(),
	emptyMessage = m.activity_attribute_none(),
	showPreview = true,
	searchAction,
	outlined,
	onSelect,
}: {
	attributes: AttributeDefinition[] | undefined;
	loading: boolean;
	options?: ListOption[];
	optionsHeading?: string;
	/** The chosen field or option value, marked in the list. */
	selected?: string;
	isDisabled?: (field: string) => boolean;
	searchPlaceholder?: string;
	emptyMessage?: string;
	showPreview?: boolean;
	searchAction?: ReactNode;
	/** Outline the search box when the list is shown inline rather than in a popover. */
	outlined?: boolean;
	onSelect: (field: string, attribute?: AttributeDefinition) => void;
}) {
	// Members can hide attributes; one already chosen stays so it can be read and cleared.
	const filterable = (attributes ?? []).filter(
		(attribute) =>
			isFieldKey(attribute.key) &&
			(attribute.status !== "hidden" ||
				attributeField(attribute.scope, attribute.key) === selected),
	);
	const groups = [
		{ scope: "point", label: m.activity_attribute_point() },
		{ scope: "resource", label: m.activity_attribute_resource() },
	] as const;
	const previews = new Map<string, PickerPreview>(
		filterable.map((attribute) => [
			`${attributeField(attribute.scope, attribute.key)}/${attribute.kind}`,
			attributePreview(attribute),
		]),
	);
	const chosen = filterable.find(
		(attribute) => attributeField(attribute.scope, attribute.key) === selected,
	);
	const chosenOption = options.find((option) => option.value === selected);
	let current: string | undefined;
	if (chosen)
		current = `${attributeField(chosen.scope, chosen.key)}/${chosen.kind}`;
	else if (chosenOption)
		current = `option ${chosenOption.label} ${chosenOption.value}`;
	return (
		<PickerCommand
			current={current}
			search={searchPlaceholder}
			previews={showPreview ? previews : undefined}
			searchAction={searchAction}
			outlined={outlined}
		>
			<CommandEmpty>
				{loading ? m.activity_attribute_loading() : emptyMessage}
			</CommandEmpty>
			{options.length > 0 && (
				<CommandGroup heading={optionsHeading}>
					{options.map((option) => (
						<CommandItem
							key={option.value}
							value={`option ${option.label} ${option.value}`}
							disabled={isDisabled?.(option.value)}
							data-checked={option.value === selected}
							onSelect={() => onSelect(option.value)}
						>
							{option.label}
						</CommandItem>
					))}
				</CommandGroup>
			)}
			{groups.map((group) => {
				const items = filterable.filter(
					(attribute) => attribute.scope === group.scope,
				);
				return items.length ? (
					<CommandGroup key={group.scope} heading={group.label}>
						{items.map((attribute) => {
							const field = attributeField(attribute.scope, attribute.key);
							return (
								<CommandItem
									key={`${attribute.scope}/${attribute.key}/${attribute.kind}`}
									value={`${field}/${attribute.kind}`}
									keywords={[
										group.scope,
										attributeLabel(attribute.key),
										attribute.key,
									]}
									disabled={isDisabled?.(field)}
									data-checked={field === selected}
									onSelect={() => onSelect(field, attribute)}
								>
									<DefinitionChoice
										kind="attribute"
										name={attribute.key}
										description={attribute.note}
									/>
								</CommandItem>
							);
						})}
					</CommandGroup>
				) : null;
			})}
		</PickerCommand>
	);
}
