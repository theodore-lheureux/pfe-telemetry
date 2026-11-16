import { m } from "@recount/i18n/messages";
import { ArrowLeftIcon, ListFilterPlusIcon, PlusIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Button } from "../components/ui/button";
import {
	Command,
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
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../components/ui/popover";
import { AttributeList } from "./attribute-list";
import { useAttributeValues, type ValueSource } from "./catalog";
import type { AttributeDefinition, Filter, FilterOperator } from "./contracts";
import { DefinitionChoice } from "./definition-choice";
import { attributeField } from "./fields";
import { PICKER_CONTENT_CLASS } from "./picker-command";

type Operator = Extract<FilterOperator, "eq" | "neq" | "exists" | "not_exists">;
const OPERATORS: Operator[] = ["eq", "neq", "exists", "not_exists"];
export const OPERATOR_LABEL: Record<Operator, () => string> = {
	eq: m.activity_filter_eq,
	neq: m.activity_filter_neq,
	exists: m.activity_filter_exists,
	not_exists: m.activity_filter_not_exists,
};

/** Picks a discovered attribute, then a condition and value, and adds the filter. */
export function AttributeFilter({
	attributes,
	loading,
	disabled,
	trigger = "button",
	label,
	values,
	onOpen,
	onAdd,
}: {
	attributes: AttributeDefinition[] | undefined;
	/** Where the chosen attribute's recent values are suggested from. */
	values: ValueSource;
	loading: boolean;
	disabled: boolean;
	/** `button` for toolbars, `ghost` for panel sections, `icon` inside a series row. */
	trigger?: "button" | "ghost" | "icon";
	/** The button's text, when the default does not fit the place. */
	label?: string;
	onOpen: () => void;
	onAdd: (filter: Filter) => void;
}) {
	const id = useId();
	const [open, setOpen] = useState(false),
		[field, setField] = useState<AttributeDefinition | null>(null),
		[operator, setOperator] = useState<Operator>("eq"),
		[value, setValue] = useState("");
	const reset = () => {
		setField(null);
		setOperator("eq");
		setValue("");
	};
	const needsValue = operator === "eq" || operator === "neq";
	const chosen = field && attributeField(field.scope, field.key);
	const suggestions = useAttributeValues(
		values,
		open && needsValue ? chosen : null,
	);
	const add = (text: string) => {
		if (!chosen || (needsValue && !text.trim())) return;
		onAdd(
			needsValue
				? { field: chosen, op: operator, values: [text.trim()] }
				: { field: chosen, op: operator },
		);
		setOpen(false);
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		add(value);
	};
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				// Reset on opening, so the closing popover keeps its content while it fades.
				if (next) {
					reset();
					onOpen();
				}
				setOpen(next);
			}}
		>
			<PopoverTrigger asChild>
				{trigger === "icon" ? (
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={m.activity_attribute_filter()}
						title={m.activity_attribute_filter()}
						disabled={disabled}
					>
						<ListFilterPlusIcon aria-hidden="true" />
					</Button>
				) : (
					<Button
						variant={trigger === "ghost" ? "ghost" : "outline"}
						size={trigger === "ghost" ? "sm" : "default"}
						disabled={disabled}
					>
						<PlusIcon aria-hidden="true" />
						{label ??
							(trigger === "ghost"
								? m.insight_filter_add()
								: m.activity_attribute_filter())}
					</Button>
				)}
			</PopoverTrigger>
			<PopoverContent
				className={field ? "w-80 p-0" : PICKER_CONTENT_CLASS}
				align="start"
			>
				{field ? (
					<form onSubmit={submit} className="flex flex-col gap-3 p-3">
						<div className="flex items-center gap-1">
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label={m.activity_filter_back()}
								onClick={() => setField(null)}
							>
								<ArrowLeftIcon aria-hidden="true" />
							</Button>
							<div className="flex min-w-0 flex-1 items-center gap-2">
								<DefinitionChoice kind="attribute" name={field.key} />
							</div>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`${id}-operator`} className="sr-only">
								{m.activity_filter_operator()}
							</Label>
							<NativeSelect
								id={`${id}-operator`}
								value={operator}
								onChange={(event) =>
									setOperator(event.target.value as Operator)
								}
								className="w-full"
							>
								{OPERATORS.map((option) => (
									<NativeSelectOption key={option} value={option}>
										{OPERATOR_LABEL[option]()}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>
						{needsValue && (
							<ValueField
								value={value}
								suggestions={suggestions.data}
								loading={suggestions.isFetching}
								onChange={setValue}
								onPick={add}
							/>
						)}
						<Button type="submit" disabled={needsValue && !value.trim()}>
							{m.activity_filter_apply()}
						</Button>
					</form>
				) : (
					<AttributeList
						attributes={attributes}
						loading={loading}
						onSelect={(_, attribute) => attribute && setField(attribute)}
					/>
				)}
			</PopoverContent>
		</Popover>
	);
}

/**
 * The value to compare with: typed freely, or picked from the attribute's recent
 * values. Enter applies the highlighted suggestion or the typed text.
 */
function ValueField({
	value,
	suggestions,
	loading,
	onChange,
	onPick,
}: {
	value: string;
	suggestions: string[] | undefined;
	loading: boolean;
	onChange: (value: string) => void;
	onPick: (value: string) => void;
}) {
	const typed = value.trim();
	return (
		// cmdk names its input with this label; it replaces the input's own ID.
		<Command className="rounded-md border" label={m.activity_filter_value()}>
			<CommandInput
				value={value}
				maxLength={1024}
				placeholder={m.activity_filter_value()}
				onValueChange={onChange}
				autoFocus
			/>
			<CommandList className="max-h-48">
				{typed && !suggestions?.includes(typed) && (
					<CommandGroup>
						<CommandItem
							value={`typed ${typed}`}
							onSelect={() => onPick(typed)}
						>
							{m.activity_filter_use_value({ value: typed })}
						</CommandItem>
					</CommandGroup>
				)}
				{suggestions?.length ? (
					<CommandGroup heading={m.activity_filter_recent_values()}>
						{suggestions.map((suggestion) => (
							<CommandItem
								key={suggestion}
								value={suggestion}
								onSelect={() => onPick(suggestion)}
							>
								<span className="truncate font-mono text-xs">{suggestion}</span>
							</CommandItem>
						))}
					</CommandGroup>
				) : (
					!typed && (
						<p className="px-3 py-2 text-xs text-muted-foreground">
							{loading
								? m.activity_attribute_loading()
								: m.activity_filter_no_values()}
						</p>
					)
				)}
			</CommandList>
		</Command>
	);
}
