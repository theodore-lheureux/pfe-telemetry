import { m } from "@recount/i18n/messages";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../../components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../../components/ui/popover";

export interface FacetOption {
	value: string;
	label: string;
	/** Shown before the label, such as an icon or avatar. */
	leading?: ReactNode;
	/** Shown after the label in muted text, such as "(you)". */
	note?: string;
}

/** A toolbar button that filters a list to any of several values. */
export function FacetFilter({
	label,
	icon,
	options,
	selected,
	searchable,
	onChange,
}: {
	label: string;
	icon?: ReactNode;
	options: FacetOption[];
	selected: string[];
	/** Adds a search field, for long lists such as people. */
	searchable?: boolean;
	onChange: (selected: string[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const chosen = new Set(selected);
	const toggle = (value: string) =>
		onChange(
			chosen.has(value)
				? selected.filter((entry) => entry !== value)
				: [...selected, value],
		);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" aria-expanded={open}>
					{icon}
					{label}
					{selected.length > 0 && (
						<Badge variant="secondary" className="px-1.5">
							{selected.length}
						</Badge>
					)}
					<ChevronDownIcon aria-hidden="true" className="opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64 p-0">
				<Command>
					{searchable && <CommandInput placeholder={m.saved_filter_search()} />}
					<CommandList>
						<CommandEmpty>{m.saved_filter_none()}</CommandEmpty>
						{selected.length > 0 && (
							<CommandGroup className="border-b">
								<CommandItem onSelect={() => onChange([])}>
									<XIcon aria-hidden="true" />
									{m.saved_filter_clear()}
								</CommandItem>
							</CommandGroup>
						)}
						<CommandGroup>
							{options.map((option) => (
								<CommandItem
									key={option.value}
									value={`${option.label} ${option.value}`}
									onSelect={() => toggle(option.value)}
								>
									<Checkbox
										checked={chosen.has(option.value)}
										tabIndex={-1}
										aria-hidden="true"
										className="pointer-events-none"
									/>
									{option.leading}
									<span className="truncate">{option.label}</span>
									{option.note && (
										<span className="text-muted-foreground">{option.note}</span>
									)}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
