import { m } from "@recount/i18n/messages";
import { ClockAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../components/ui/badge";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../components/ui/popover";

function HintBadge({
	children,
	hint,
	variant,
}: {
	children: ReactNode;
	hint: string;
	variant: "default" | "secondary" | "outline";
}) {
	return (
		// A popover rather than a tooltip, so the explanation also opens on touch.
		<Popover>
			<PopoverTrigger asChild>
				<Badge variant={variant} asChild>
					<button type="button">{children}</button>
				</Badge>
			</PopoverTrigger>
			<PopoverContent className="w-72 text-sm text-pretty">
				{hint}
			</PopoverContent>
		</Popover>
	);
}

/**
 * Whether any participant is still open, and that collector clocks are not known to be
 * synchronized: no collector reports a verified clock offset yet.
 */
export function ExecutionStatus({ live }: { live: boolean }) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			{live ? (
				<HintBadge variant="default" hint={m.execution_timeline_live_hint()}>
					<span
						aria-hidden="true"
						className="size-1.5 rounded-full bg-current"
					/>
					{m.execution_timeline_live()}
				</HintBadge>
			) : (
				<HintBadge variant="secondary" hint={m.execution_timeline_ended_hint()}>
					{m.execution_timeline_ended()}
				</HintBadge>
			)}
			<HintBadge variant="outline" hint={m.execution_timeline_clock_hint()}>
				<ClockAlertIcon aria-hidden="true" />
				{m.execution_timeline_clock_unknown()}
			</HintBadge>
		</div>
	);
}
