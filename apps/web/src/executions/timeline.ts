import type { ExecutionFact } from "./contracts";

// Layout for the execution timeline. Times are milliseconds since the epoch; positions
// are percentages of the execution's observed span.

/** A single observation still gets a visible span. */
const MIN_SPAN_MS = 1000;
/** The narrowest bar, in percent, so an instant-long interval stays visible and focusable. */
const MIN_BAR_WIDTH = 0.75;
const TICK_STEPS_MS = [
	1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600,
	43_200, 86_400, 172_800, 604_800,
].map((seconds) => seconds * 1000);

export interface Span {
	from: number;
	to: number;
}

/**
 * Where an interval stops: its explicit, exclusive end, else its last observation. An
 * open interval is never extended to the current time.
 */
export function intervalEnd(fact: ExecutionFact) {
	return (fact.ended ?? fact.lastSeen).getTime();
}

/** The execution's observed extent, from the first observation to the latest end. */
export function executionSpan(facts: ExecutionFact[]): Span | null {
	if (!facts.length) return null;
	let from = Number.POSITIVE_INFINITY;
	let to = Number.NEGATIVE_INFINITY;
	for (const fact of facts) {
		from = Math.min(from, fact.firstSeen.getTime());
		to = Math.max(to, intervalEnd(fact));
	}
	return { from, to: Math.max(to, from + MIN_SPAN_MS) };
}

/** Whether any participant or process has not reported an end. */
export function isLive(facts: ExecutionFact[]) {
	return facts.some((fact) => fact.ended === null);
}

export interface Placement {
	left: number;
	width: number;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** An interval's bar within the span, clamped to it and never thinner than a sliver. */
export function place(span: Span, start: number, end: number): Placement {
	const total = span.to - span.from;
	const from = clamp((start - span.from) / total);
	const to = clamp((Math.max(start, end) - span.from) / total);
	const width = Math.max((to - from) * 100, MIN_BAR_WIDTH);
	return { left: Math.min(from * 100, 100 - width), width };
}

/** An instant's position within the span, or null outside it. */
export function position(span: Span, at: number) {
	if (at < span.from || at > span.to) return null;
	return ((at - span.from) / (span.to - span.from)) * 100;
}

/** The instant at a fraction of the span, such as a pointer's position along the track. */
export function instantAt(span: Span, fraction: number) {
	return Math.round(span.from + clamp(fraction) * (span.to - span.from));
}

/** The step between axis labels: the finest that keeps them to `count`. */
export function tickStep(span: Span, count = 6) {
	const total = span.to - span.from;
	return (
		TICK_STEPS_MS.find((candidate) => total / candidate <= count) ??
		Math.ceil(total / count / 86_400_000) * 86_400_000
	);
}

/** Evenly stepped axis labels inside the span, at most `count` of them. */
export function axisTicks(span: Span, count = 6) {
	const step = tickStep(span, count);
	const ticks: number[] = [];
	for (
		let tick = Math.ceil(span.from / step) * step;
		tick <= span.to;
		tick += step
	)
		ticks.push(tick);
	return ticks;
}

export interface TimelineInterval {
	fact: ExecutionFact;
	open: boolean;
	placement: Placement;
}

export interface TimelineParticipant {
	participantId: string;
	/** Null when only the participant's process memberships are visible. */
	lifecycle: TimelineInterval | null;
	processes: TimelineInterval[];
}

export interface TimelineNode {
	nodeId: string;
	participants: TimelineParticipant[];
}

const byStart = (a: ExecutionFact, b: ExecutionFact) =>
	a.firstSeen.getTime() - b.firstSeen.getTime() ||
	(a.pid ?? 0) - (b.pid ?? 0) ||
	(a.factId < b.factId ? -1 : 1);

function earliest(participant: TimelineParticipant) {
	return Math.min(
		...[
			participant.lifecycle?.fact,
			...participant.processes.map((entry) => entry.fact),
		].flatMap((fact) => (fact ? [fact.firstSeen.getTime()] : [])),
	);
}

const byEarliest =
	<T>(start: (entry: T) => number, id: (entry: T) => string) =>
	(a: T, b: T) =>
		start(a) - start(b) || (id(a) < id(b) ? -1 : 1);

/**
 * Nodes, each with its participants' lifecycles and their process memberships, ordered
 * by when they were first seen. Memberships whose lifecycle is absent keep their own row.
 */
export function timelineNodes(
	facts: ExecutionFact[],
	span: Span,
): TimelineNode[] {
	const nodes = new Map<string, Map<string, TimelineParticipant>>();
	for (const fact of [...facts].sort(byStart)) {
		const participants = nodes.get(fact.nodeId) ?? new Map();
		nodes.set(fact.nodeId, participants);
		const participant: TimelineParticipant = participants.get(
			fact.participantId,
		) ?? { participantId: fact.participantId, lifecycle: null, processes: [] };
		participants.set(fact.participantId, participant);
		const interval = {
			fact,
			open: fact.ended === null,
			placement: place(span, fact.firstSeen.getTime(), intervalEnd(fact)),
		};
		if (fact.kind === 1) participant.lifecycle = interval;
		else participant.processes.push(interval);
	}
	const sortedParticipants = byEarliest<TimelineParticipant>(
		earliest,
		(entry) => entry.participantId,
	);
	return [...nodes]
		.map(([nodeId, participants]) => ({
			nodeId,
			participants: [...participants.values()].sort(sortedParticipants),
		}))
		.sort(
			byEarliest(
				(node) => earliest(node.participants[0]),
				(node) => node.nodeId,
			),
		);
}
