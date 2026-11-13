import { m } from "@recount/i18n/messages";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../components/ui/command";
import type { AttributeDefinition } from "./contracts";
import { attributeField, isFieldKey } from "./fields";
import { attributeLabel } from "./metric-names";

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
	onSelect,
}: {
	attributes: AttributeDefinition[] | undefined;
	loading: boolean;
	options?: ListOption[];
	optionsHeading?: string;
	/** The chosen field or option value, marked in the list. */
	selected?: string;
	onSelect: (field: string, attribute?: AttributeDefinition) => void;
}) {
	const filterable = (attributes ?? []).filter((attribute) =>
		isFieldKey(attribute.key),
	);
	const groups = [
		{ scope: "point", label: m.activity_attribute_point() },
		{ scope: "resource", label: m.activity_attribute_resource() },
	] as const;
	const check = (value: string): ReactNode =>
		value === selected && (
			<CheckIcon aria-hidden="true" className="ml-auto size-4" />
		);
	return (
		<Command>
			<CommandInput placeholder={m.activity_attribute_search()} />
			<CommandList>
				<CommandEmpty>
					{loading
						? m.activity_attribute_loading()
						: m.activity_attribute_none()}
				</CommandEmpty>
				{options.length > 0 && (
					<CommandGroup heading={optionsHeading}>
						{options.map((option) => (
							<CommandItem
								key={option.value}
								value={`option ${option.label} ${option.value}`}
								onSelect={() => onSelect(option.value)}
							>
								{option.label}
								{check(option.value)}
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
										value={`${group.scope} ${attributeLabel(attribute.key)} ${attribute.key}`}
										onSelect={() => onSelect(field, attribute)}
									>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate">
												{attributeLabel(attribute.key)}
											</span>
											{attributeLabel(attribute.key) !== attribute.key && (
												<span className="truncate font-mono text-[11px] text-muted-foreground">
													{attribute.key}
												</span>
											)}
										</span>
										{check(field)}
									</CommandItem>
								);
							})}
						</CommandGroup>
					) : null;
				})}
			</CommandList>
		</Command>
	);
}
