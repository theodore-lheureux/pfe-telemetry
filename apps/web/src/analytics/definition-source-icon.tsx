import { m } from "@recount/i18n/messages";
import { CalculatorIcon, CodeIcon } from "lucide-react";
import { BrandLogo } from "../components/recount/brand-logo";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { isCalculatedMetric } from "./calculated-metrics";
import { isNamedAttribute, isNamedMetric } from "./metric-names";

export type DefinitionKind = "metric" | "attribute";

const SOURCES = {
	metric: {
		known: isNamedMetric,
		builtIn: m.definitions_source_builtin,
		custom: m.definitions_source_custom,
	},
	attribute: {
		known: isNamedAttribute,
		builtIn: m.definitions_source_builtin_attribute,
		custom: m.definitions_source_custom_attribute,
	},
};

export function DefinitionSourceIcon({
	kind,
	name,
	className,
}: {
	kind: DefinitionKind;
	name: string;
	className?: string;
}) {
	const source = SOURCES[kind];
	const calculated = kind === "metric" && isCalculatedMetric(name);
	const builtIn = source.known(name);
	let label = builtIn ? source.builtIn() : source.custom();
	if (calculated) label = m.calculated_metric();
	const Icon = calculated ? CalculatorIcon : CodeIcon;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className={cn("flex w-fit shrink-0 items-center", className)}>
					{builtIn ? (
						<BrandLogo variant="symbol" label={label} className="size-4" />
					) : (
						<Icon
							role="img"
							aria-label={label}
							className="size-4 text-muted-foreground"
						/>
					)}
				</span>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
