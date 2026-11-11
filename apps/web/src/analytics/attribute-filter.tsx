import { m } from "@recount/i18n/messages";
import { ArrowLeftIcon, PlusIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type {
	AttributeDefinition,
	Filter,
	FilterOperator,
} from "../analytics/contracts";
import { attributeField, isFieldKey } from "../analytics/fields";
import { attributeLabel } from "../analytics/metric-names";
import { Button } from "../components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../components/ui/command";
import { Input } from "../components/ui/input";
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
	onOpen,
	onAdd,
}: {
	attributes: AttributeDefinition[] | undefined;
	loading: boolean;
	disabled: boolean;
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
	const filterable = (attributes ?? []).filter((attribute) =>
		isFieldKey(attribute.key),
	);
	const groups = [
		{ scope: "point", label: m.activity_attribute_point() },
		{ scope: "resource", label: m.activity_attribute_resource() },
	] as const;
	const needsValue = operator === "eq" || operator === "neq";
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!field || (needsValue && !value.trim())) return;
		onAdd(
			needsValue
				? {
						field: attributeField(field.scope, field.key),
						op: operator,
						values: [value.trim()],
					}
				: { field: attributeField(field.scope, field.key), op: operator },
		);
		setOpen(false);
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
				<Button variant="outline" disabled={disabled}>
					<PlusIcon aria-hidden="true" />
					{m.activity_attribute_filter()}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80 p-0" align="start">
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
							<span className="min-w-0 truncate text-sm font-medium">
								{attributeLabel(field.key)}
							</span>
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
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={`${id}-value`} className="sr-only">
									{m.activity_filter_value()}
								</Label>
								<Input
									id={`${id}-value`}
									value={value}
									maxLength={1024}
									autoComplete="off"
									placeholder={m.activity_filter_value()}
									onChange={(event) => setValue(event.target.value)}
									autoFocus
								/>
							</div>
						)}
						<Button type="submit" disabled={needsValue && !value.trim()}>
							{m.activity_filter_apply()}
						</Button>
					</form>
				) : (
					<Command>
						<CommandInput placeholder={m.activity_attribute_search()} />
						<CommandList>
							<CommandEmpty>
								{loading
									? m.activity_attribute_loading()
									: m.activity_attribute_none()}
							</CommandEmpty>
							{groups.map((group) => {
								const items = filterable.filter(
									(attribute) => attribute.scope === group.scope,
								);
								return items.length ? (
									<CommandGroup key={group.scope} heading={group.label}>
										{items.map((attribute) => (
											<CommandItem
												key={`${attribute.scope}/${attribute.key}/${attribute.kind}`}
												value={`${group.scope} ${attributeLabel(attribute.key)} ${attribute.key}`}
												onSelect={() => setField(attribute)}
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
											</CommandItem>
										))}
									</CommandGroup>
								) : null;
							})}
						</CommandList>
					</Command>
				)}
			</PopoverContent>
		</Popover>
	);
}
