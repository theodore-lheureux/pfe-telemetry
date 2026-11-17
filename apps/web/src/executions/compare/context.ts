import type { ExecutionDetail } from "../contracts";

export interface Period {
	from: Date;
	to: Date;
}

/**
 * The period measurements are aligned on, by the analytics runner's rule: the first
 * sighting of any fact to the latest explicit end, or last sighting without one.
 */
export function executionPeriod(
	execution: Pick<ExecutionDetail, "facts" | "firstSeen" | "lastSeen">,
): Period {
	if (!execution.facts.length)
		return { from: execution.firstSeen, to: execution.lastSeen };
	let from = Number.POSITIVE_INFINITY;
	let to = Number.NEGATIVE_INFINITY;
	for (const fact of execution.facts) {
		from = Math.min(from, fact.firstSeen.getTime());
		to = Math.max(to, (fact.ended ?? fact.lastSeen).getTime());
	}
	return { from: new Date(from), to: new Date(to) };
}

/** How long two periods ran at the same time, in ms; zero when they did not. */
export function overlapMs(a: Period, b: Period) {
	return Math.max(
		0,
		Math.min(a.to.getTime(), b.to.getTime()) -
			Math.max(a.from.getTime(), b.from.getTime()),
	);
}

export function nodeIds(execution: Pick<ExecutionDetail, "facts">) {
	return [...new Set(execution.facts.map((fact) => fact.nodeId))].sort();
}

/** Nodes on which both executions had participants. */
export function sharedNodes(
	a: Pick<ExecutionDetail, "facts">,
	b: Pick<ExecutionDetail, "facts">,
) {
	const other = new Set(nodeIds(b));
	return nodeIds(a).filter((node) => other.has(node));
}

/** The kernel owner UIDs participant lifecycles observed, ascending. */
export function ownerUids(execution: Pick<ExecutionDetail, "facts">) {
	const uids = new Set<number>();
	for (const fact of execution.facts)
		if (fact.kind === 1 && fact.ownerUid !== null) uids.add(fact.ownerUid);
	return [...uids].sort((left, right) => left - right);
}

export interface ParameterRow {
	key: string;
	/** Each execution's value, or null when it did not record the parameter. */
	values: [string | null, string | null];
	differs: boolean;
}

/** Every parameter either execution recorded, by key, with whether they differ. */
export function parameterRows(
	a: Record<string, string>,
	b: Record<string, string>,
): ParameterRow[] {
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	return keys.map((key) => {
		const values: [string | null, string | null] = [
			Object.hasOwn(a, key) ? a[key] : null,
			Object.hasOwn(b, key) ? b[key] : null,
		];
		return { key, values, differs: values[0] !== values[1] };
	});
}

/** Whether two lists hold the same values, in any order. */
export function sameValues<T>(a: readonly T[], b: readonly T[]) {
	const left = new Set(a);
	const right = new Set(b);
	return left.size === right.size && [...left].every((item) => right.has(item));
}
