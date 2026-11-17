import { m } from "@recount/i18n/messages";
import {
	RotateCwIcon,
	SearchXIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button";
import { IconEmptyState } from "../components/workspace";
import { operationMessage } from "../lib/operation-message";
import type { OperationResult } from "../lib/operation-result";
import type { ExecutionPage, ExecutionSummary } from "./contracts";
import { ExecutionTable } from "./execution-table";

export type ExecutionLoadError = NonNullable<OperationResult<never>["error"]>;

/** Results under the filters: the table, or why there is nothing to show. */
export function ExecutionResults({
	page,
	error,
	filtered,
	busy,
	open,
	onClear,
	onRetry,
	empty,
}: {
	page: ExecutionPage | null;
	error: ExecutionLoadError | null;
	filtered: boolean;
	busy: boolean;
	open: (execution: ExecutionSummary) => ReactNode;
	onClear: () => void;
	onRetry: () => void;
	/** Shown when an unfiltered page is empty. */
	empty: ReactNode;
}) {
	if (error || !page)
		return (
			<IconEmptyState
				alert
				icon={<TriangleAlertIcon aria-hidden="true" />}
				title={m.executions_error_title()}
				description={error ? operationMessage(error) : undefined}
				className="bg-card"
			>
				<Button variant="outline" disabled={busy} onClick={onRetry}>
					<RotateCwIcon aria-hidden="true" />
					{m.try_again()}
				</Button>
			</IconEmptyState>
		);
	if (page.executions.length > 0)
		return (
			<ExecutionTable
				executions={page.executions}
				nodes={page.nodes}
				open={open}
				busy={busy}
			/>
		);
	if (!filtered) return empty;
	return (
		<IconEmptyState
			icon={<SearchXIcon aria-hidden="true" />}
			title={m.executions_filtered_empty_title()}
			description={m.executions_filtered_empty_description()}
			className="bg-card"
		>
			<Button variant="outline" disabled={busy} onClick={onClear}>
				<XIcon aria-hidden="true" />
				{m.executions_clear_filters()}
			</Button>
		</IconEmptyState>
	);
}
