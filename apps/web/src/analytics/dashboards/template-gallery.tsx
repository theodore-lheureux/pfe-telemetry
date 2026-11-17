import { m } from "@recount/i18n/messages";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import type { MetricDefinition } from "../contracts";
import { type TemplateChoice, templateCoverage } from "../dashboard-templates";

const BLANK = "blank";
const CARD =
	"h-auto w-full flex-col items-start justify-start gap-1 whitespace-normal p-3 text-left data-[state=on]:border-primary data-[state=on]:bg-muted";

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
			orientation="vertical"
			aria-label={m.dashboard_templates_gallery()}
			className="w-full items-stretch gap-3"
			value={selected || BLANK}
			disabled={disabled}
			// A single-choice gallery always keeps one option selected.
			onValueChange={(value) => {
				if (value) onSelect(value === BLANK ? "" : value);
			}}
		>
			<ToggleGroupItem value={BLANK} className={CARD}>
				<span className="font-medium">{m.dashboard_templates_blank()}</span>
			</ToggleGroupItem>
			{(["built-in", "project"] as const).map((scope) => (
				<div key={scope} className="flex flex-col gap-2">
					<h3 className="text-sm font-medium">
						{scope === "built-in"
							? m.dashboard_templates_built_in()
							: m.dashboard_templates_project()}
					</h3>
					<div className="grid gap-2 sm:grid-cols-2">
						{choices
							.filter((choice) => choice.scope === scope)
							.map(({ id, template }) => (
								<ToggleGroupItem key={id} value={id} className={CARD}>
									<span className="font-medium">{template.name}</span>
									<span className="text-xs font-normal text-muted-foreground">
										{template.description}
									</span>
									<span className="text-xs font-normal text-muted-foreground">
										{metrics
											? m.dashboard_template_coverage(
													templateCoverage(template, metrics),
												)
											: m.dashboard_templates_coverage_loading()}
									</span>
								</ToggleGroupItem>
							))}
					</div>
				</div>
			))}
		</ToggleGroup>
	);
}
