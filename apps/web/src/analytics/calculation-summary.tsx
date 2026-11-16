import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { Badge } from "../components/ui/badge";
import type { ProjectReference } from "../organizations/contracts";
import type { CalculatedMetric } from "./calculated-metrics";
import { filterText } from "./filter-chips";
import { CALCULATION_LABEL, COMBINE_OPTION_LABEL } from "./insight/labels";
import { metricLabel } from "./metric-names";

export function CalculationSummary({
	definition,
	reference,
}: {
	definition: CalculatedMetric;
	reference: ProjectReference;
}) {
	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-base font-semibold">{m.calculated_definition()}</h2>
			<code className="rounded-md border bg-muted/30 p-3">
				{definition.expression}
			</code>
			{definition.inputs.map((input) => (
				<div key={input.name} className="flex flex-wrap items-center gap-2">
					<span className="font-mono font-semibold">{input.name}</span>
					<Link
						to="/organizations/$organizationId/projects/$projectId/definitions/metrics/$metric"
						params={{ ...reference, metric: input.metric }}
						className="font-medium hover:underline"
					>
						{metricLabel(input.metric)}
					</Link>
					<span className="text-sm text-muted-foreground">
						{CALCULATION_LABEL[input.calculation]()} ·{" "}
						{COMBINE_OPTION_LABEL[input.combine]()}
					</span>
					{(input.filters ?? []).map((filter) => (
						<Badge key={JSON.stringify(filter)} variant="outline">
							{filterText(filter)}
						</Badge>
					))}
				</div>
			))}
			<p className="text-sm text-muted-foreground">
				{definition.builtIn
					? m.calculated_builtin_readonly()
					: m.calculated_edit_warning()}
			</p>
		</section>
	);
}
