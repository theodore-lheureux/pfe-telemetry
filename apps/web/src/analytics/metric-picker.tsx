import { m } from "@recount/i18n/messages";
import { ChevronsUpDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
	CommandEmpty,
	CommandGroup,
	CommandItem,
} from "../components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../components/ui/popover";
import { cn } from "../lib/utils";
import type { MetricDefinition } from "./contracts";
import { DefinitionChoice } from "./definition-choice";
import { DefinitionSourceIcon } from "./definition-source-icon";
import { isDistribution } from "./histograms";
import {
	isNamedMetric,
	isRatioMetric,
	METRIC_SECTION_LABEL,
	METRIC_SECTIONS,
	metricLabel,
	metricSection,
	unitLabel,
} from "./metric-names";
import {
	metricPreview,
	PICKER_CONTENT_CLASS,
	PickerCommand,
	type PickerPreview,
} from "./picker-command";

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
}) {
	const [open, setOpen] = useState(false);
	const names = [
		...new Set(
			metrics
				?.filter(
					(metric) => metric.status !== "hidden" || metric.name === value,
				)
				.map((metric) => metric.name),
		),
	];
	const unit = (name: string) =>
		isRatioMetric(name)
			? "%"
			: unitLabel(metrics?.find((metric) => metric.name === name)?.unit ?? "");
	const previews = new Map<string, PickerPreview>();
	for (const name of names) {
		const metric = metrics?.find((item) => item.name === name);
		if (metric) previews.set(name, metricPreview(metric));
	}
	const metricText = (name: string) =>
		metricLabel(name, metrics?.find((metric) => metric.name === name)?.label);
	const selected = metrics?.find((metric) => metric.name === value);
	const text = value ? metricText(value) : placeholder;
	const choose = (name: string | undefined) => {
		onChange(name);
		setOpen(false);
	};
	const distribution = (name: string) =>
		isDistribution(metrics?.find((metric) => metric.name === name));
	const groups = METRIC_SECTIONS.map((section) => ({
		label: METRIC_SECTION_LABEL[section](),
		names: names.filter(
			(name) => metricSection(name, distribution(name)) === section,
		),
	}));
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
					{value ? <DefinitionSourceIcon kind="metric" name={value} /> : icon}
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-left",
							value && !isNamedMetric(value) && !selected?.label && "font-mono",
						)}
					>
						{text}
					</span>
					<ChevronsUpDownIcon aria-hidden="true" className="opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className={PICKER_CONTENT_CLASS} align="start">
				<PickerCommand search={m.insight_metric_search()} previews={previews}>
					<CommandEmpty>{m.insight_no_metrics()}</CommandEmpty>
					<CommandGroup>
						{allLabel && (
							<CommandItem
								value={allLabel}
								data-checked={value === undefined}
								onSelect={() => choose(undefined)}
							>
								{allLabel}
							</CommandItem>
						)}
					</CommandGroup>
					{groups
						.filter((group) => group.names.length)
						.map((group) => (
							<CommandGroup key={group.label} heading={group.label}>
								{group.names.map((name) => (
									<CommandItem
										key={name}
										// Search matches the friendly and the technical name.
										value={name}
										keywords={[metricText(name)]}
										data-checked={value === name}
										onSelect={() => choose(name)}
									>
										<DefinitionChoice
											kind="metric"
											name={name}
											label={metricText(name)}
											description={previews.get(name)?.description}
										/>
										{distribution(name) && (
											<Badge variant="outline">
												{m.metric_distribution_badge()}
											</Badge>
										)}
										{unit(name) && (
											<span className="text-xs text-muted-foreground">
												{unit(name)}
											</span>
										)}
									</CommandItem>
								))}
							</CommandGroup>
						))}
				</PickerCommand>
			</PopoverContent>
		</Popover>
	);
}
