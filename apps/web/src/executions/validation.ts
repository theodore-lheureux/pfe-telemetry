import { parseUuid } from "../lib/input";
import { parseProjectReference } from "../organizations/validation";
import {
	EXECUTION_STATES,
	type ExecutionFilters,
	type ExecutionListInput,
	type ExecutionReference,
	type ExecutionState,
	MAX_FILTER_VALUES,
} from "./contracts";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid request");
	return value as Record<string, unknown>;
}
export function parseExecutionKey(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.trim() !== value ||
		!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
	)
		throw new Error("Invalid execution key");
	return value;
}
export function parseExecutionReference(value: unknown): ExecutionReference {
	return {
		...parseProjectReference(value),
		executionKey: parseExecutionKey(record(value).executionKey),
	};
}

const invalidFilter = (): never => {
	throw new Error("Invalid execution filter");
};

/** Trimmed text of 1–128 characters without control characters. */
function parseText(value: unknown) {
	if (
		typeof value !== "string" ||
		!value ||
		value.trim() !== value ||
		value.length > 128 ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected.
		/[\u0000-\u001f\u007f]/.test(value)
	)
		invalidFilter();
	return value as string;
}

function parseValues<T>(value: unknown, parse: (entry: unknown) => T): T[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > MAX_FILTER_VALUES
	)
		invalidFilter();
	return [...new Set((value as unknown[]).map(parse))];
}

function parseOwner(value: unknown) {
	if (
		!Number.isInteger(value) ||
		(value as number) < 0 ||
		(value as number) > 0xffffffff
	)
		invalidFilter();
	return value as number;
}

function parseState(value: unknown): ExecutionState {
	if (!EXECUTION_STATES.includes(value as ExecutionState)) invalidFilter();
	return value as ExecutionState;
}

// Times are stored as UInt64 Unix nanoseconds, which end in 2554.
const LATEST_TIME = Date.UTC(2500, 0, 1);
function parseTime(value: unknown) {
	if (
		!(value instanceof Date) ||
		!(value.getTime() >= 0 && value.getTime() <= LATEST_TIME)
	)
		invalidFilter();
	return value as Date;
}

const FILTERS: {
	[K in keyof ExecutionFilters]-?: (value: unknown) => ExecutionFilters[K];
} = {
	q: parseText,
	application: (value) => parseValues(value, parseText),
	state: parseState,
	machine: (value) => parseValues(value, (entry) => parseUuid(entry, "node")),
	owner: (value) => parseValues(value, parseOwner),
	from: parseTime,
	to: parseTime,
};
const FILTER_KEYS = Object.keys(FILTERS) as (keyof ExecutionFilters)[];

function checkPeriod(filters: ExecutionFilters) {
	if (filters.from && filters.to && filters.from >= filters.to) invalidFilter();
	return filters;
}

/** Validated filters; absent or undefined fields do not filter. */
export function parseExecutionFilters(value: unknown): ExecutionFilters {
	const input = record(value);
	const filters: Record<string, unknown> = {};
	for (const key of FILTER_KEYS)
		if (input[key] !== undefined) filters[key] = FILTERS[key](input[key]);
	return checkPeriod(filters as ExecutionFilters);
}

export function parseExecutionList(value: unknown): ExecutionListInput {
	const input = record(value);
	return {
		...parseProjectReference(value),
		...parseExecutionFilters(input),
		...(input.afterKey == null
			? {}
			: { afterKey: parseExecutionKey(input.afterKey) }),
	};
}

/** The list's URL state: filters with ISO times, and the page cursor. */
export type ExecutionSearch = Omit<ExecutionFilters, "from" | "to"> & {
	from?: string;
	to?: string;
	afterKey?: string;
};

function isoTime(value: unknown) {
	if (typeof value !== "string") return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : undefined;
}

const LIST_FILTERS = new Set<keyof ExecutionFilters>([
	"application",
	"machine",
	"owner",
]);

function urlFilter(key: keyof ExecutionFilters, value: unknown) {
	if (key === "from" || key === "to") return FILTERS[key](isoTime(value));
	if (key === "q" && typeof value === "string")
		return FILTERS.q(value.trim().slice(0, 128));
	// Hand-written links may give one value, such as `?machine=<id>`.
	if (LIST_FILTERS.has(key) && !Array.isArray(value))
		return FILTERS[key]([value]);
	return FILTERS[key](value);
}

/** URL search state; values that are not valid filters are dropped rather than failing. */
export function parseExecutionSearch(
	search: Record<string, unknown>,
): ExecutionSearch {
	const filters: Record<string, unknown> = {};
	for (const key of FILTER_KEYS) {
		if (search[key] === undefined) continue;
		try {
			filters[key] = urlFilter(key, search[key]);
		} catch {
			// An edited or outdated link keeps its other filters.
		}
	}
	let period: ExecutionFilters = filters;
	try {
		period = checkPeriod(filters);
	} catch {
		const { from: _, to: __, ...rest } = filters;
		period = rest;
	}
	const result: ExecutionSearch = {
		...period,
		from: period.from?.toISOString(),
		to: period.to?.toISOString(),
	};
	try {
		if (search.afterKey !== undefined)
			result.afterKey = parseExecutionKey(search.afterKey);
	} catch {
		// A malformed cursor restarts at the first page.
	}
	return Object.fromEntries(
		Object.entries(result).filter(([, entry]) => entry !== undefined),
	);
}

/** The server filters for URL search state. */
export function searchFilters(search: ExecutionSearch): ExecutionFilters {
	const { from, to, afterKey: _, ...rest } = search;
	return {
		...rest,
		...(from ? { from: new Date(from) } : {}),
		...(to ? { to: new Date(to) } : {}),
	};
}

export function hasExecutionFilters(search: ExecutionSearch) {
	return FILTER_KEYS.some((key) => search[key] !== undefined);
}
