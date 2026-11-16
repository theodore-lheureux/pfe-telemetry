import { m } from "@recount/i18n/messages";
import { Button } from "../../components/ui/button";
import type { MetricDefinition } from "../contracts";
import { type TemplateChoice, templateCoverage } from "../dashboard-templates";

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
		<section
			aria-label={m.dashboard_templates_gallery()}
			className="flex flex-col gap-3"
		>
			<Button
				type="button"
				variant={selected === "" ? "secondary" : "outline"}
				aria-pressed={selected === ""}
				disabled={disabled}
				onClick={() => onSelect("")}
			>
				{m.dashboard_templates_blank()}
			</Button>
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
								<Button
									key={id}
									type="button"
									variant={selected === id ? "secondary" : "outline"}
									aria-pressed={selected === id}
									disabled={disabled}
									className="h-auto flex-col items-start whitespace-normal p-3 text-left"
									onClick={() => onSelect(id)}
								>
									<span className="font-medium">{template.name}</span>
									<span className="text-xs text-muted-foreground">
										{template.description}
									</span>
									<span className="text-xs text-muted-foreground">
										{metrics
											? m.dashboard_template_coverage(
													templateCoverage(template, metrics),
												)
											: m.dashboard_templates_coverage_loading()}
									</span>
								</Button>
							))}
					</div>
				</div>
			))}
		</section>
	);
}
