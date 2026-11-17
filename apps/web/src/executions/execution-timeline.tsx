import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { cn } from "cn";
import { type ReactNode, useState } from "react";
import { useDisplayTimeZone } from "../components/time-display";
import { Button } from "../components/ui/button";
import { Slider } from "../components/ui/slider";
import type { ExecutionFact } from "./contracts";
import type { SelectionPatch } from "./execution-search";
import { ExecutionStatus } from "./execution-status";
import {
	axisTicks,
	isLive,
	position,
	type Span,
	type TimelineNode,
	tickStep,
	timelineNodes,
} from "./timeline";
import { processName, TimelineIntervalBar } from "./timeline-interval";

function Row({
	label,
	children,
	selected,
	className,
}: {
	label: ReactNode;
	children?: ReactNode;
	selected?: boolean;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"col-span-2 grid grid-cols-subgrid",
				selected && "bg-muted",
				className,
			)}
		>
			<div
				className={cn(
					"sticky left-0 z-10 flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm",
					selected ? "bg-muted" : "bg-card",
				)}
			>
				{label}
			</div>
			<div className="relative mr-6 ml-2">{children}</div>
		</div>
	);
}

function InstantLine({ span, instant }: { span: Span; instant: number }) {
	const left = position(span, instant);
	if (left === null) return null;
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-y-0 w-px bg-foreground/50"
			style={{ left: `${left}%` }}
		/>
	);
}

function NodeRows({
	node,
	label,
	span,
	instant,
	selected,
	onSelect,
}: {
	node: TimelineNode;
	label: string;
	span: Span;
	instant: number;
	selected: boolean;
	onSelect: (patch: SelectionPatch) => void;
}) {
	const line = <InstantLine span={span} instant={instant} />;
	const select = (fact: ExecutionFact) => () =>
		onSelect({ node: node.nodeId, at: fact.firstSeen.getTime() });
	return (
		<>
			<div
				className={cn(
					"col-span-2 border-t px-3 py-1.5",
					selected ? "bg-muted" : "bg-card",
				)}
			>
				{/* The machine name spans the track, so narrow screens keep it whole. */}
				<div className="sticky left-3 flex max-w-[calc(100vw-4rem)]">
					<Button
						variant={selected ? "secondary" : "ghost"}
						size="sm"
						aria-pressed={selected}
						aria-label={m.execution_timeline_select_machine({ node: label })}
						title={node.nodeId}
						className="-ml-2 min-w-0 justify-start font-medium"
						onClick={() => onSelect({ node: selected ? null : node.nodeId })}
					>
						<span className="truncate">{label}</span>
					</Button>
				</div>
			</div>
			{node.participants.map((participant) => (
				<div key={participant.participantId} className="contents">
					<Row
						selected={selected}
						label={
							<span
								className="truncate text-muted-foreground"
								title={participant.participantId}
							>
								{participant.lifecycle
									? m.execution_lifecycle()
									: m.execution_timeline_no_lifecycle()}
							</span>
						}
					>
						<div className="h-7">
							{line}
							{participant.lifecycle && (
								<TimelineIntervalBar
									interval={participant.lifecycle}
									name={m.execution_lifecycle()}
									nodeLabel={label}
									onSelect={select(participant.lifecycle.fact)}
								/>
							)}
						</div>
					</Row>
					{participant.processes.map((process) => (
						<Row
							key={process.fact.factId}
							selected={selected}
							label={
								<span className="truncate pl-4 text-muted-foreground tabular-nums">
									{processName(process.fact)}
								</span>
							}
						>
							<div className="h-6">
								{line}
								<TimelineIntervalBar
									interval={process}
									name={processName(process.fact)}
									nodeLabel={label}
									onSelect={select(process.fact)}
								/>
							</div>
						</Row>
					))}
				</div>
			))}
		</>
	);
}

function InstantSlider({
	span,
	instant,
	step,
	selected,
	onSelect,
}: {
	span: Span;
	instant: number;
	step: number;
	selected: boolean;
	onSelect: (patch: SelectionPatch) => void;
}) {
	const zone = useDisplayTimeZone();
	const format = new Intl.DateTimeFormat(getLocale(), {
		timeZone: zone,
		dateStyle: "medium",
		timeStyle: "medium",
	});
	// The thumb follows a drag locally; the URL changes once it is released.
	const [dragging, setDragging] = useState<number | null>(null);
	const value = dragging ?? instant;
	return (
		<Row
			label={
				<div className="flex min-w-0 flex-col">
					<span className="text-xs text-muted-foreground">
						{m.execution_timeline_instant()}
					</span>
					<span className="truncate text-xs font-medium tabular-nums">
						{selected || dragging !== null
							? format.format(value)
							: m.execution_timeline_latest()}
					</span>
				</div>
			}
		>
			<div className="flex h-10 items-center">
				<Slider
					min={span.from}
					max={span.to}
					step={Math.max(1, Math.min(step, span.to - span.from))}
					value={[value]}
					onValueChange={([next]) => setDragging(next ?? null)}
					onValueCommit={([next]) => {
						setDragging(null);
						if (next !== undefined) onSelect({ at: next });
					}}
					thumbProps={{
						"aria-label": m.execution_timeline_instant(),
						"aria-valuetext": format.format(value),
					}}
				/>
			</div>
		</Row>
	);
}

function Axis({ span }: { span: Span }) {
	const zone = useDisplayTimeZone();
	const step = tickStep(span);
	const format = new Intl.DateTimeFormat(getLocale(), {
		timeZone: zone,
		...(step >= 86_400_000
			? { month: "short", day: "numeric" }
			: { hour: "2-digit", minute: "2-digit" }),
		...(step < 60_000 ? { second: "2-digit" as const } : {}),
	});
	return (
		<Row label={null}>
			<div
				role="img"
				aria-label={m.execution_timeline_axis()}
				className="h-5 text-[11px] text-muted-foreground tabular-nums"
			>
				{axisTicks(span).map((tick) => (
					<span
						key={tick}
						className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
						style={{ left: `${position(span, tick) ?? 0}%` }}
					>
						{format.format(tick)}
					</span>
				))}
			</div>
		</Row>
	);
}

/**
 * Each machine's participant lifecycles and process memberships on one time axis, with
 * the instant whose measurements the page shows.
 */
export function ExecutionTimeline({
	facts,
	nodeNames,
	span,
	selectedNode,
	instant,
	selectedInstant,
	step,
	onSelect,
}: {
	facts: ExecutionFact[];
	nodeNames: Record<string, string>;
	span: Span;
	selectedNode: string | undefined;
	/** The instant shown: the selected one, else the latest. */
	instant: number;
	selectedInstant: boolean;
	/** The measurement interval in ms, which the instant snaps to. */
	step: number;
	onSelect: (patch: SelectionPatch) => void;
}) {
	const nodes = timelineNodes(facts, span);
	return (
		<section
			aria-labelledby="execution-timeline"
			className="flex flex-col gap-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 id="execution-timeline" className="text-lg font-semibold">
					{m.execution_timeline_title()}
				</h2>
				<ExecutionStatus live={isLive(facts)} />
			</div>
			<p className="max-w-3xl text-sm text-pretty text-muted-foreground">
				{m.execution_intervals_hint()}
			</p>
			<div className="overflow-x-auto rounded-lg border bg-card">
				<div className="grid min-w-[36rem] grid-cols-[8.5rem_minmax(0,1fr)] pb-2 sm:grid-cols-[minmax(9rem,16rem)_minmax(0,1fr)]">
					<InstantSlider
						span={span}
						instant={instant}
						step={step}
						selected={selectedInstant}
						onSelect={onSelect}
					/>
					<Axis span={span} />
					{nodes.map((node) => (
						<NodeRows
							key={node.nodeId}
							node={node}
							label={nodeNames[node.nodeId] ?? node.nodeId}
							span={span}
							instant={instant}
							selected={node.nodeId === selectedNode}
							onSelect={onSelect}
						/>
					))}
				</div>
			</div>
		</section>
	);
}
