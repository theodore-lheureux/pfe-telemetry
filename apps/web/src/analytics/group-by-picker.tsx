import { m } from "@recount/i18n/messages";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../components/ui/popover";
import { cn } from "../lib/utils";
import { AttributeList, type ListOption } from "./attribute-list";
import type { AttributeDefinition } from "./contracts";
import { attributeLabel } from "./definition-labels";
import { DefinitionSourceIcon } from "./definition-source-icon";
import { parseAttributeField } from "./fields";
import { PICKER_CONTENT_CLASS } from "./picker-command";

const CORE_GROUP_LABEL: Record<string, () => string> = {
	execution: m.execution_field,
	node: m.insight_group_node,
	host: m.insight_group_host,
	"resource.id": m.insight_group_resource,
};

/** A grouping field as people read it. */
export function groupFieldLabel(field: string) {
	const core = CORE_GROUP_LABEL[field];
	if (core) return core();
	return attributeLabel(parseAttributeField(field)?.key ?? field);
}

/**
 * Picks a breakdown from discovered attributes and the caller's reset/inherit choices.
 */
export function GroupByPicker({
	value,
	choices,
	attributes,
	loading,
	disabled,
	className,
	label,
	onOpen,
	onChange,
}: {
	/** A field, or one of `choices`' values. */
	value: string;
	choices: ListOption[];
	attributes: AttributeDefinition[] | undefined;
	loading: boolean;
	disabled: boolean;
	className?: string;
	/** The visible label of a field holding the picker, which then drops its own prefix. */
	label?: string;
	/** Attributes load the first time the list opens. */
	onOpen: () => void;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const attribute = parseAttributeField(value);
	const current =
		choices.find((option) => option.value === value)?.label ??
		groupFieldLabel(value);
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (next) onOpen();
				setOpen(next);
			}}
		>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					disabled={disabled}
					aria-label={`${label ?? m.insight_group_by()}: ${current}`}
					className={cn("max-w-80 justify-start", className)}
				>
					{attribute && (
						<DefinitionSourceIcon kind="attribute" name={attribute.key} />
					)}
					{!label && (
						<span className="text-muted-foreground">
							{m.insight_group_by()}
						</span>
					)}
					<span className="truncate">{current}</span>
					<ChevronDownIcon aria-hidden="true" className="ml-auto opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className={PICKER_CONTENT_CLASS} align="start">
				<AttributeList
					attributes={attributes}
					loading={loading}
					options={[
						...choices,
						{ value: "execution", label: m.execution_field() },
					]}
					selected={value}
					onSelect={(next) => {
						onChange(next);
						setOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}
