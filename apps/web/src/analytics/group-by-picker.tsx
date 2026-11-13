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
import { parseAttributeField } from "./fields";
import { attributeLabel } from "./metric-names";

const CORE_GROUPS = ["node", "host", "resource.id"];

const CORE_GROUP_LABEL: Record<string, () => string> = {
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
 * Picks what series are grouped by from a searchable list: the caller's choices, such
 * as no grouping, then core fields, then discovered attributes.
 */
export function GroupByPicker({
	value,
	choices,
	attributes,
	loading,
	disabled,
	className,
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
	/** Attributes load the first time the list opens. */
	onOpen: () => void;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const options = [
		...choices,
		...CORE_GROUPS.map((field) => ({
			value: field,
			label: groupFieldLabel(field),
		})),
	];
	const current =
		options.find((option) => option.value === value)?.label ??
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
					aria-label={`${m.insight_group_by()}: ${current}`}
					className={cn("max-w-80 justify-start", className)}
				>
					<span className="text-muted-foreground">{m.insight_group_by()}</span>
					<span className="truncate">{current}</span>
					<ChevronDownIcon aria-hidden="true" className="ml-auto opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80 p-0" align="start">
				<AttributeList
					attributes={attributes}
					loading={loading}
					options={options}
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
