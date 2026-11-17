import { m } from "@recount/i18n/messages";
import { Badge } from "../../components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import type { MetricDefinition } from "../contracts";
import { type TemplateChoice, templateCoverage } from "../dashboard-templates";

const BLANK = "blank";
const CARD =
	"h-auto w-full flex-col items-start justify-start gap-1 whitespace-normal p-3 text-left font-normal data-[state=on]:border-primary data-[state=on]:bg-muted";

function TemplateCard({
	value,
	name,
	description,
	detail,
	project = false,
}: {
	value: string;
	name: string;
	description: string;
	detail?: string;
	project?: boolean;
}) {
	return (
		<ToggleGroupItem value={value} className={CARD}>
			<span className="flex w-full items-center gap-2">
				<span className="font-medium">{name}</span>
				{project && (
					<Badge variant="outline" className="ml-auto">
						{m.dashboard_templates_project_badge()}
					</Badge>
				)}
			</span>
			<span className="text-xs text-muted-foreground">{description}</span>
			{detail && (
				<span className="text-xs text-muted-foreground">{detail}</span>
			)}
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
	return (
		<ToggleGroup
			type="single"
			variant="outline"
			aria-label={m.dashboard_templates_gallery()}
			className="grid w-full items-stretch gap-2 sm:grid-cols-2"
			value={selected || BLANK}
			disabled={disabled}
			// A single-choice gallery always keeps one option selected.
			onValueChange={(value) => {
				if (value) onSelect(value === BLANK ? "" : value);
			}}
		>
			<TemplateCard
				value={BLANK}
				name={m.dashboard_templates_blank()}
				description={m.dashboard_templates_blank_description()}
			/>
			{choices.map(({ id, scope, template }) => (
				<TemplateCard
					key={id}
					value={id}
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
