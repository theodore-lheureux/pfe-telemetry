import {
	parseSerializedRange,
	type SerializedRange,
	serializeRange,
} from "../components/date-range/date-range";
import { InputError } from "../lib/input-error";
import {
	type Comparison,
	type Filter,
	INTERVALS,
	type Interval,
	MAX_FILTERS,
} from "./contracts";
import type { InsightDraft } from "./insight/draft";
import { parseComparison, parseField, parseFilter } from "./validation";

// Overrides a dashboard applies to every tile. An absent key keeps each insight's own
// setting; filters are added to each insight's own.

export interface DashboardFilters {
	range?: SerializedRange;
	interval?: Interval;
	filters?: Filter[];
	/** Replaces each insight's breakdown; "" removes it. */
	breakdown?: string;
	/** Replaces each insight's comparison; null removes it. */
	compare?: Comparison | null;
}

/** The longest overrides text accepted from a URL or for saving. */
export const MAX_DASHBOARD_FILTERS_LENGTH = 4096;

function invalid(): never {
	throw new InputError("INVALID_QUERY", "Invalid dashboard filters");
}

/** Validated overrides, with keys in one order so equal overrides have equal text. */
export function parseDashboardFilters(value: unknown): DashboardFilters {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const input = value as Record<string, unknown>;
	const known = ["range", "interval", "filters", "breakdown", "compare"];
	if (Object.keys(input).some((key) => !known.includes(key))) invalid();
	const result: DashboardFilters = {};
	if (input.range !== undefined) {
		const range = parseSerializedRange(input.range);
		if (!range)
			throw new InputError("INVALID_TIME_RANGE", "Invalid time range");
		result.range = serializeRange(range);
	}
	if (input.interval !== undefined) {
		if (!Object.hasOwn(INTERVALS, input.interval as string)) invalid();
		result.interval = input.interval as Interval;
	}
	if (input.filters !== undefined) {
		if (!Array.isArray(input.filters) || input.filters.length > MAX_FILTERS)
			invalid();
		if (input.filters.length) result.filters = input.filters.map(parseFilter);
	}
	if (input.breakdown !== undefined) {
		if (input.breakdown !== "") parseField(input.breakdown);
		result.breakdown = input.breakdown as string;
	}
	if (input.compare !== undefined)
		result.compare =
			input.compare === null ? null : parseComparison(input.compare);
	return result;
}

/** The overrides in URL text, or null when it cannot be read. */
export function decodeDashboardFilters(text: string): DashboardFilters | null {
	if (text.length > MAX_DASHBOARD_FILTERS_LENGTH) return null;
	try {
		return parseDashboardFilters(JSON.parse(text));
	} catch {
		return null;
	}
}

export function encodeDashboardFilters(filters: DashboardFilters) {
	return JSON.stringify(parseDashboardFilters(filters));
}

export function hasDashboardFilters(filters: DashboardFilters) {
	return Object.keys(filters).length > 0;
}

/** An insight's draft as the dashboard shows it. */
export function applyDashboardFilters(
	draft: InsightDraft,
	filters: DashboardFilters,
): InsightDraft {
	const range = filters.range && parseSerializedRange(filters.range);
	const next: InsightDraft = {
		...draft,
		...(range ? { range } : {}),
		...(filters.interval ? { interval: filters.interval } : {}),
		filters: [...draft.filters, ...(filters.filters ?? [])].slice(
			0,
			MAX_FILTERS,
		),
	};
	if (filters.breakdown !== undefined && draft.display.type !== "stat") {
		// A collapsed breakdown belongs to the insight's own grouping.
		const { aggregate: _, ...rest } = next;
		return applyCompare(
			{ ...rest, groupBy: filters.breakdown || undefined },
			filters,
		);
	}
	return applyCompare(next, filters);
}

function applyCompare(draft: InsightDraft, filters: DashboardFilters) {
	if (filters.compare === undefined) return draft;
	const { compare: _, ...rest } = draft;
	return filters.compare ? { ...rest, compare: filters.compare } : rest;
}

/** How many overrides differ: each changed setting, and each added or removed filter. */
export function changedFilterCount(
	current: DashboardFilters,
	saved: DashboardFilters,
) {
	const keys = ["range", "interval", "breakdown", "compare"] as const;
	const changed = keys.filter(
		(key) => JSON.stringify(current[key]) !== JSON.stringify(saved[key]),
	).length;
	const text = (filters: DashboardFilters) =>
		new Set((filters.filters ?? []).map((filter) => JSON.stringify(filter)));
	const now = text(current),
		before = text(saved);
	const filters =
		[...now].filter((filter) => !before.has(filter)).length +
		[...before].filter((filter) => !now.has(filter)).length;
	return changed + filters;
}

/**
 * A tile's own overrides: they apply over the dashboard's, or alone when it ignores them.
 * `ignoreFilters` keeps the dashboard's range and settings but drops its filters on these
 * fields, as context tiles beside an execution's processes do.
 */
export type TileOverrides = DashboardFilters & {
	ignoreDashboard?: true;
	ignoreFilters?: string[];
};

function parseIgnoredFields(value: unknown) {
	if (
		!Array.isArray(value) ||
		!value.length ||
		value.length > MAX_FILTERS ||
		new Set(value).size !== value.length
	)
		invalid();
	for (const field of value) parseField(field);
	return value as string[];
}

export function parseTileOverrides(value: unknown): TileOverrides {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const { ignoreDashboard, ignoreFilters, ...rest } = value as Record<
		string,
		unknown
	>;
	if (ignoreDashboard !== undefined && typeof ignoreDashboard !== "boolean")
		invalid();
	return {
		...(ignoreDashboard ? { ignoreDashboard: true as const } : {}),
		...(ignoreFilters === undefined
			? {}
			: { ignoreFilters: parseIgnoredFields(ignoreFilters) }),
		...parseDashboardFilters(rest),
	};
}

export function decodeTileOverrides(text: string): TileOverrides {
	try {
		return parseTileOverrides(JSON.parse(text));
	} catch {
		return {};
	}
}

export function encodeTileOverrides(overrides: TileOverrides) {
	return JSON.stringify(parseTileOverrides(overrides));
}

/** The dashboard's overrides that reach a tile. */
export function inheritedFilters(
	dashboard: DashboardFilters,
	tile: TileOverrides,
): DashboardFilters {
	if (tile.ignoreDashboard) return {};
	const ignored = tile.ignoreFilters;
	if (!ignored || !dashboard.filters) return dashboard;
	const { filters, ...rest } = dashboard;
	const kept = filters.filter((filter) => !ignored.includes(filter.field));
	return kept.length ? { ...rest, filters: kept } : rest;
}

/** A tile's draft as its dashboard shows it: the dashboard's overrides, then its own. */
export function tileDraft(
	draft: InsightDraft,
	dashboard: DashboardFilters,
	tile: TileOverrides,
): InsightDraft {
	const { ignoreDashboard: _, ignoreFilters: __, ...own } = tile;
	return applyDashboardFilters(
		applyDashboardFilters(draft, inheritedFilters(dashboard, tile)),
		own,
	);
}
