import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MutationFailure } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import type { OverviewSection, QueryRange } from "../contracts";
import type {
	OverviewMetric,
	OverviewSectionResult,
	OverviewStat,
} from "../overview.server";
import { mergeNodes, nodesMetric } from "./combine";
import { overviewSectionQuery } from "./overview-query";

type Failure = MutationFailure["failure"];

/** A statistic's card: still loading, or its result. */
export interface OverviewTile {
	stat: OverviewStat;
	metric: OverviewMetric | null;
	bucketSeconds: number | null;
	/** No result yet: the card shows its loading shape. */
	pending: boolean;
	/** A newer result is on its way. */
	fetching: boolean;
}

interface SectionState {
	section: OverviewSection;
	/** Undefined until loaded; null when the project lacks the section's metrics. */
	data: OverviewSectionResult | null | undefined;
	pending: boolean;
	fetching: boolean;
	failure: Failure | null;
	placeholder: boolean;
	updatedAt: number;
}

function failureOf(error: unknown): Failure | null {
	return error instanceof MutationFailure ? error.failure : null;
}

function sectionTile(state: SectionState): OverviewTile | null {
	if (state.data === null || (state.failure && !state.data)) return null;
	return {
		stat: state.section,
		metric: state.data?.metric ?? null,
		bucketSeconds: state.data?.bucketSeconds ?? null,
		pending: state.pending,
		fetching: state.fetching,
	};
}

/** The Nodes card waits for CPU and memory, since it counts nodes in either. */
function nodesTile(states: SectionState[]): OverviewTile | null {
	const sources = states.filter((state) => state.section !== "processes");
	const loaded = sources.flatMap((state) => (state.data ? [state.data] : []));
	const pending = sources.some((state) => state.pending);
	if (!pending && !loaded.length) return null;
	return {
		stat: "nodes",
		metric: pending ? null : nodesMetric(loaded),
		bucketSeconds: loaded[0]?.bucketSeconds ?? null,
		pending,
		fetching: sources.some((state) => state.fetching),
	};
}

/** One section's query; a new range keeps the previous result until its own arrives. */
function useSection(
	userId: string,
	reference: ProjectReference,
	range: QueryRange,
	section: OverviewSection,
): SectionState {
	const result = useQuery({
		...overviewSectionQuery(userId, reference, range, section),
		placeholderData: keepPreviousData,
		refetchOnWindowFocus: false,
	});
	return {
		section,
		data: result.data,
		pending: result.data === undefined && !result.isError,
		fetching: result.isFetching,
		failure: failureOf(result.error),
		placeholder: result.isPlaceholderData,
		updatedAt: result.dataUpdatedAt,
	};
}

/** The overview's sections, each loading on its own, combined into cards and rows. */
export function useOverview(
	userId: string,
	reference: ProjectReference,
	range: QueryRange,
) {
	// One query each rather than `useQueries`, which drops previous results on new keys.
	const states = [
		useSection(userId, reference, range, "cpu"),
		useSection(userId, reference, range, "memory"),
		useSection(userId, reference, range, "processes"),
	];
	const loaded = states.flatMap((state) => (state.data ? [state.data] : []));
	const tiles = [nodesTile(states), ...states.map(sectionTile)].filter(
		(tile): tile is OverviewTile => tile !== null,
	);
	const failures = states.flatMap((state) =>
		state.failure ? [state.failure] : [],
	);
	const settled = states.every((state) => !state.pending);
	const current = states.every(
		(state) => state.data !== undefined && !state.placeholder,
	);
	return {
		tiles,
		nodes: mergeNodes(loaded),
		/** Sections whose table columns are still loading. */
		pendingSections: new Set(
			states.filter((state) => state.pending).map((state) => state.section),
		),
		fetching: states.some((state) => state.fetching),
		failure: failures[0] ?? null,
		/** Every section failed, so nothing can show. */
		failed: failures.length === states.length,
		/** Every section settled and none applies to this project. */
		empty: settled && !failures.length && !loaded.length,
		/** When the oldest section was computed, once all are current. */
		computedAt: current
			? new Date(Math.min(...states.map((state) => state.updatedAt)))
			: null,
	};
}
