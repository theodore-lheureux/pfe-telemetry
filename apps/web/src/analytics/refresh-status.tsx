import { m } from "@recount/i18n/messages";
import { RefreshCwIcon } from "lucide-react";
import { TimeDisplay } from "../components/time-display";
import { Button } from "../components/ui/button";

/** When results were computed, or that newer ones are loading. */
export function ComputedAt({
	computedAt,
	fetching,
}: {
	/** Null while a newer result loads. */
	computedAt: Date | null;
	fetching: boolean;
}) {
	if (fetching || !computedAt)
		return (
			<span className="text-xs text-muted-foreground">
				{m.insight_updating()}
			</span>
		);
	return (
		<span className="flex items-center gap-1 text-xs text-muted-foreground">
			{m.insight_computed()} <TimeDisplay value={computedAt} mode="relative" />
		</span>
	);
}

export function RefreshButton({
	fetching,
	disabled,
	onRefresh,
}: {
	fetching: boolean;
	disabled: boolean;
	onRefresh: () => void;
}) {
	return (
		<Button
			variant="ghost"
			size="sm"
			disabled={disabled || fetching}
			onClick={onRefresh}
		>
			<RefreshCwIcon
				aria-hidden="true"
				className={fetching ? "motion-safe:animate-spin" : ""}
			/>
			{m.overview_refresh()}
		</Button>
	);
}
