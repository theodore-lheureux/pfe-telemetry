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
export const MAX_MEASURES = 4;
export const MAX_FILTERS = 8;
export const MAX_GROUP_BY = 2;
export const MAX_SERIES = 50;

/** Core fields, or attribute lookups such as `attributes["cpu.mode"]`. */
export type FieldName = string;
export type CoreField =
	| "node"
	| "host"
	| "resource.id"
	| "resource.kind"
	| "scope.name";

export type Calculation = "last" | "avg" | "min" | "max" | "rate" | "increase";
export type Combine = "sum" | "avg" | "min" | "max";
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

export interface AnalyticsQuery {
	shape: "timeseries" | "table";
	range: QueryRange;
	/** Required for timeseries; ignored for table results. */
	interval?: Interval;
	measures: Measure[];
	filters?: Filter[];
	groupBy?: FieldName[];
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
	measure: string;
	/** Group-by values in `groupBy` order; null when a series lacks the field. */
	group: (string | null)[];
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
	series: SeriesResult[];
	/** True when more groups matched than the series limit returned. */
	limited: boolean;
}
