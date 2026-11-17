import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { InfoIcon, LayersIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import type { ExecutionDetail } from "../contracts";
import { executionPeriod, overlapMs, sharedNodes } from "./context";
import { formatDuration } from "./elapsed";

/**
 * Whether the executions ran at the same time, and on which shared nodes. Overlap is
 * context for a difference, never shown as its cause.
 */
export function TimingNote({
	executions: [a, b],
}: {
	executions: [ExecutionDetail, ExecutionDetail];
}) {
	const overlap = overlapMs(executionPeriod(a), executionPeriod(b));
	const shared = sharedNodes(a, b).length;
	if (overlap === 0)
		return (
			<Alert data-timing="isolated">
				<InfoIcon aria-hidden="true" />
				<AlertTitle>{m.execution_compare_isolated()}</AlertTitle>
				<AlertDescription className="text-pretty">
					{m.execution_compare_isolated_description()}
				</AlertDescription>
			</Alert>
		);
	const locale = getLocale();
	return (
		<Alert data-timing="concurrent">
			<LayersIcon aria-hidden="true" />
			<AlertTitle>
				{m.execution_compare_concurrent({
					duration: formatDuration(overlap, locale),
				})}
			</AlertTitle>
			<AlertDescription className="text-pretty">
				<p>
					{m.execution_compare_shared_nodes({
						count: new Intl.NumberFormat(locale).format(shared),
					})}
				</p>
				<p>{m.execution_compare_not_causation()}</p>
			</AlertDescription>
		</Alert>
	);
}
