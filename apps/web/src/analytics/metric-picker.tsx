import { m } from "@recount/i18n/messages";
import { ChevronsUpDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "../components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "../components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../components/ui/popover";
import { cn } from "../lib/utils";
import type { MetricDefinition } from "./contracts";
import { isNamedMetric, metricLabel, unitLabel } from "./metric-names";

/**
 * A searchable metric combobox showing friendly names, technical names and units.
 * Metrics are chosen by name; kind or unit variants of one name share an entry.
 */
export function MetricPicker({
	id,
	metrics,
	value,
	onChange,
	disabled,
	placeholder,
	allLabel,
	icon,
	labelled,
	className,
	presets = [],
	onPreset,
}: {
	id?: string;
	metrics: MetricDefinition[] | undefined;
	value: string | undefined;
	onChange: (name: string | undefined) => void;
	disabled: boolean;
	placeholder: string;
	/** Adds a first entry that clears the choice. */
	allLabel?: string;
	icon?: ReactNode;
	/** True when a `<Label htmlFor={id}>` names the trigger. */
	labelled?: boolean;
	className?: string;
	/** Calculated entries listed first, such as CPU usage; choosing one calls `onPreset`. */
	presets?: {
		id: string;
		label: string;
		description: string;
		/** Why it cannot be chosen now; shown in place of the description. */
		unavailable?: string;
	}[];
	onPreset?: (id: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const names = [...new Set(metrics?.map((metric) => metric.name))];
	const unit = (name: string) =>
		unitLabel(metrics?.find((metric) => metric.name === name)?.unit ?? "");
	const text = value ? metricLabel(value) : placeholder;
	const choose = (name: string | undefined) => {
		onChange(name);
		setOpen(false);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					id={id}
					variant="outline"
					role="combobox"
					aria-expanded={open}
					// A combobox is not named by its content; without a label, name it by its text.
					aria-label={labelled ? undefined : text}
					disabled={disabled}
					className={cn("justify-between font-normal", className)}
				>
					{icon}
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-left",
							value && !isNamedMetric(value) && "font-mono",
						)}
					>
						{text}
					</span>
					<ChevronsUpDownIcon aria-hidden="true" className="opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-(--radix-popover-trigger-width) min-w-80 p-0"
				align="start"
			>
				<Command>
					<CommandInput placeholder={m.insight_metric_search()} />
					<CommandList>
						<CommandEmpty>{m.insight_no_metrics()}</CommandEmpty>
						{presets.length > 0 && (
							<CommandGroup heading={m.insight_metric_presets()}>
								{presets.map((preset) => (
									<CommandItem
										key={preset.id}
										value={`${preset.label} ${preset.description}`}
										disabled={preset.unavailable !== undefined}
										onSelect={() => {
											onPreset?.(preset.id);
											setOpen(false);
										}}
									>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate">{preset.label}</span>
											<span className="truncate text-[11px] text-muted-foreground">
												{preset.unavailable ?? preset.description}
											</span>
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						)}
						<CommandGroup
							heading={presets.length > 0 ? m.insight_metric_raw() : undefined}
						>
							{allLabel && (
								<CommandItem
									value={allLabel}
									data-checked={value === undefined}
									onSelect={() => choose(undefined)}
								>
									{allLabel}
								</CommandItem>
							)}
							{names.map((name) => (
								<CommandItem
									key={name}
									// Search matches the friendly and the technical name.
									value={`${metricLabel(name)} ${name}`}
									data-checked={value === name}
									onSelect={() => choose(name)}
								>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate">{metricLabel(name)}</span>
										{isNamedMetric(name) && (
											<span className="truncate font-mono text-[11px] text-muted-foreground">
												{name}
											</span>
										)}
									</span>
									{unit(name) && (
										<span className="text-xs text-muted-foreground">
											{unit(name)}
										</span>
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
