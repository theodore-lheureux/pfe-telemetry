import { m } from "@recount/i18n/messages";
import {
	LayoutTemplateIcon,
	type LucideIcon,
	MicrochipIcon,
	ServerIcon,
	SquarePlusIcon,
} from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import type { MetricDefinition } from "../contracts";
import { type TemplateChoice, templateCoverage } from "../dashboard-templates";

const BLANK = "blank";
const CARD =
	"h-auto w-full items-start justify-start gap-3 whitespace-normal p-3 text-left font-normal data-[state=on]:border-primary data-[state=on]:bg-muted";
const ICON: Record<string, LucideIcon> = {
	[BLANK]: SquarePlusIcon,
	"node-health": ServerIcon,
	gpu: MicrochipIcon,
};

function TemplateCard({
	value,
	name,
	description,
	detail,
	project = false,
	onPick,
}: {
	value: string;
	name: string;
	description: string;
	detail?: string;
	project?: boolean;
	onPick: (value: string) => void;
}) {
	const Icon = ICON[value] ?? LayoutTemplateIcon;
	return (
		// A click picks the card even when it is already selected.
		<ToggleGroupItem
			value={value}
			className={CARD}
			onClick={() => onPick(value)}
		>
			<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
				<Icon aria-hidden="true" className="size-4" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex items-center gap-2">
					<span className="font-medium">{name}</span>
					{project && (
						<Badge variant="outline">
							{m.dashboard_templates_project_badge()}
						</Badge>
					)}
				</span>
				<span className="line-clamp-2 text-xs text-muted-foreground">
					{description}
				</span>
				{detail && (
					<span className="text-xs text-muted-foreground">{detail}</span>
				)}
			</span>
		</ToggleGroupItem>
	);
}

/** One grid of starting points: blank, built-in and this project's templates. */
export function TemplateGallery({
	choices,
	selected,
	metrics,
	disabled,
	onSelect,
}: {
	choices: TemplateChoice[];
	selected: string;
	metrics?: MetricDefinition[];
	disabled: boolean;
	onSelect: (id: string) => void;
}) {
	const pick = (value: string) => onSelect(value === BLANK ? "" : value);
	return (
		<ToggleGroup
			type="single"
			variant="outline"
			aria-label={m.dashboard_templates_gallery()}
			className="grid w-full items-stretch gap-2 sm:grid-cols-2"
			value={selected || BLANK}
			disabled={disabled}
		>
			<TemplateCard
				value={BLANK}
				onPick={pick}
				name={m.dashboard_templates_blank()}
				description={m.dashboard_templates_blank_description()}
			/>
			{choices.map(({ id, scope, template }) => (
				<TemplateCard
					key={id}
					value={id}
					onPick={pick}
					name={template.name}
					description={template.description}
					project={scope === "project"}
					detail={
						metrics
							? m.dashboard_template_coverage(
									templateCoverage(template, metrics),
								)
							: m.dashboard_templates_coverage_loading()
					}
				/>
			))}
		</ToggleGroup>
	);
}
