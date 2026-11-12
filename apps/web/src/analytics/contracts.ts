import type { ProjectReference } from "../organizations/contracts";

// The typed analytical query contract from docs/telemetry-semantic-model.md. Builders,
// saved analyses and execution pages produce it; only the server compiles it to SQL.

export const INTERVALS = {
	"10s": 10,
	"1m": 60,
	"5m": 300,
	"15m": 900,
	"1h": 3600,
	"1d": 86400,
} as const;
export type Interval = keyof typeof INTERVALS;

export const RELATIVE_RANGES = {
	"15m": 900,
	"1h": 3600,
	"6h": 21600,
	"24h": 86400,
	"7d": 604800,
	"30d": 2592000,
} as const;
export type RelativeRange = keyof typeof RELATIVE_RANGES;

export const MAX_RANGE_SECONDS = 2592000;
export const MAX_BUCKETS = 600;
/** Series letters A–Z. */
export const MAX_MEASURES = 26;
export const MAX_FILTERS = 8;
export const MAX_GROUP_BY = 2;
export const MAX_SERIES = 50;
export const DEFAULT_SERIES_LIMIT = 25;
export const MAX_FORMULAS = 26;
/** Rows one query may return: measures × groups × buckets, per window. */
export const MAX_RESULT_POINTS = 200_000;
export const COMPARE_UNITS = ["hours", "days", "weeks", "months"] as const;
export type CompareUnit = (typeof COMPARE_UNITS)[number];

/** Core fields, or attribute lookups such as `attributes["cpu.mode"]`. */
export type FieldName = string;
export type CoreField =
	| "node"
	| "host"
	| "resource.id"
	| "resource.kind"
	| "scope.name";

export type Calculation = "last" | "avg" | "min" | "max" | "rate" | "increase";
/** How the values of a measure's sources combine per bucket (and per group). */
export const COMBINES = [
	"sum",
	"avg",
	"count",
	"min",
	"max",
	"p50",
	"p90",
	"p95",
	"p99",
] as const;
export type Combine = (typeof COMBINES)[number];
export type FilterOperator =
	| "eq"
	| "neq"
	| "in"
	| "not_in"
	| "exists"
	| "not_exists";

export interface Filter {
	field: FieldName;
	op: FilterOperator;
	values?: string[];
}

export interface Measure {
	name: string;
	metric: string;
	calculation: Calculation;
	combine: Combine;
	filters?: Filter[];
}

export type QueryRange = { last: RelativeRange } | { from: string; to: string };

/** A named arithmetic expression over measure names, evaluated per bucket and group. */
export interface Formula {
	name: string;
	expression: string;
}

/** The earlier window to compare with: the previous period of equal length, or a fixed offset. */
export type Comparison =
	| { previous: true }
	| { amount: number; unit: CompareUnit };

export interface AnalyticsQuery {
	shape: "timeseries" | "table";
	range: QueryRange;
	/** Required for timeseries; ignored for table results. */
	interval?: Interval;
	measures: Measure[];
	/** When present, results show these instead of the measures they read. */
	formulas?: Formula[];
	filters?: Filter[];
	groupBy?: FieldName[];
	/** Groups kept per measure, largest first; defaults to `DEFAULT_SERIES_LIMIT`. */
	limit?: number;
	/** Fold the groups past the limit into one "Other" series. */
	other?: boolean;
	compare?: Comparison;
	/**
	 * Collapses the groups of each measure or formula into one series, after formulas
	 * run, such as the 99th percentile of CPU usage across nodes. Requires `groupBy`.
	 */
	aggregate?: Combine;
}

export type RunQueryInput = ProjectReference & { query: AnalyticsQuery };
/** Without a metric, lists the attributes seen on any metric in the project. */
export type MetricAttributesInput = ProjectReference & { metric?: string };

/** How a stored metric behaves, which decides the calculations it allows. */
export type MetricBehavior = "gauge" | "counter" | "delta" | "unsupported";

export interface MetricDefinition {
	name: string;
	kind: number;
	temporality: number;
	monotonic: boolean | null;
	unit: string;
	description: string;
	behavior: MetricBehavior;
	lastSeen: Date;
}

export interface AttributeDefinition {
	metric: string;
	scope: "resource" | "point";
	key: string;
	kind: number;
}

export interface SeriesResult {
	/** A measure or formula name. */
	measure: string;
	/** Group-by values in `groupBy` order; null when a series lacks the field. */
	group: (string | null)[];
	/** The remaining groups past the limit, combined. */
	other?: boolean;
	/** The comparison window, with buckets shifted to line up with the current ones. */
	comparison?: boolean;
	/** Bucket start in milliseconds since the epoch, or null for table results. */
	points: { bucketMs: number | null; value: number | null }[];
}

export interface QueryResult {
	shape: AnalyticsQuery["shape"];
	from: Date;
	to: Date;
	bucketSeconds: number | null;
	groupBy: FieldName[];
	measures: {
		name: string;
		metric: string;
		unit: string;
		calculation: Calculation;
	}[];
	formulas: Formula[];
	series: SeriesResult[];
	/** True when more groups matched than the series limit returned. */
	limited: boolean;
	/** The comparison window, when one was requested. */
	compared: { from: Date; to: Date } | null;
	/**
	 * Per node, the bucket starts (ms) in which its collector reported at all, which tells
	 * a node that was offline from one that sent no points for this metric. Null when
	 * unknown: table results, or projects whose sources do not send collector heartbeats.
	 */
	coverage: Record<string, number[]> | null;
	/** How groups were collapsed, when they were. */
	aggregate?: Combine;
}
