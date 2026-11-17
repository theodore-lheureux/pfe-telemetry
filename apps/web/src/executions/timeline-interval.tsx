import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { cn } from "cn";
import { useDisplayTimeZone } from "../components/time-display";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../components/ui/tooltip";
import { formatExactTime } from "../lib/time-display";
import type { ExecutionFact } from "./contracts";
import type { TimelineInterval } from "./timeline";

function Detail({ term, children }: { term: string; children: string }) {
	return (
		<>
			<dt className="opacity-70">{term}</dt>
			<dd className="tabular-nums break-all">{children}</dd>
		</>
	);
}

/** A process's PID, kept as the identifier the system shows, or a generic name. */
export function processName(fact: ExecutionFact) {
	if (fact.pid === null) return m.execution_timeline_process_unknown();
	return m.execution_timeline_process({ pid: String(fact.pid) });
}

function ProcessDetails({ fact }: { fact: ExecutionFact }) {
	return (
		<>
			{fact.processResourceId && (
				<Detail term={m.execution_timeline_process_resource()}>
					{fact.processResourceId}
				</Detail>
			)}
			<Detail term={m.execution_process_identity()}>
				{`${fact.namespaceId ?? "—"} / ${fact.startTimeTicks ?? "—"}`}
			</Detail>
			<Detail term={m.execution_process_owner()}>
				{fact.ownerUid === null ? "—" : String(fact.ownerUid)}
			</Detail>
			<Detail term={m.execution_environment_variables()}>
				{fact.environmentVariable}
			</Detail>
		</>
	);
}

/**
 * One lifecycle or process membership bar. Open intervals end at their last observation
 * with a dashed tail; selecting a bar shows its machine's measurements at its start.
 */
export function TimelineIntervalBar({
	interval,
	name,
	nodeLabel,
	onSelect,
}: {
	interval: TimelineInterval;
	name: string;
	nodeLabel: string;
	onSelect: () => void;
}) {
	const zone = useDisplayTimeZone();
	const locale = getLocale();
	const { fact, open, placement } = interval;
	const time = (value: Date) => formatExactTime(value, locale, zone);
	const from = time(fact.firstSeen);
	const to = time(fact.ended ?? fact.lastSeen);
	const label = open
		? m.execution_timeline_open_interval({ name, from, to })
		: m.execution_timeline_closed_interval({ name, from, to });
	const lifecycle = fact.kind === 1;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={`${label} · ${nodeLabel}`}
					data-open={open || undefined}
					onClick={onSelect}
					className="group absolute inset-y-0 flex min-w-3 items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
					style={{ left: `${placement.left}%`, width: `${placement.width}%` }}
				>
					<span
						aria-hidden="true"
						className={cn(
							"relative h-2.5 w-full rounded-full transition-[filter] group-hover:brightness-110",
							lifecycle ? "bg-primary" : "h-2 bg-(--viz-1)/70",
							open &&
								"rounded-r-none after:absolute after:top-1/2 after:left-full after:ml-0.5 after:w-3 after:-translate-y-1/2 after:border-t-2 after:border-dashed after:border-current",
							open && (lifecycle ? "text-primary" : "text-(--viz-1)"),
						)}
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent side="top" className="block max-w-sm">
				<p className="font-medium">
					{name} · {nodeLabel}
				</p>
				<dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
					<Detail term={m.execution_first_seen()}>{from}</Detail>
					<Detail term={m.execution_last_seen()}>{time(fact.lastSeen)}</Detail>
					<Detail term={m.execution_interval_end()}>
						{fact.ended ? time(fact.ended) : m.execution_end_unknown()}
					</Detail>
					{!lifecycle && <ProcessDetails fact={fact} />}
				</dl>
				{open && (
					<p className="mt-1">{m.execution_timeline_still_observed()}</p>
				)}
				<p className="mt-1 opacity-70">{m.execution_timeline_select_hint()}</p>
			</TooltipContent>
		</Tooltip>
	);
}
