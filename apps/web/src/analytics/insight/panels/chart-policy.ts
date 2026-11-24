const standard = {
	queryShape: "timeseries",
	needsHistogram: false,
	needsGroupBy: false,
	reducesSeries: false,
	bucketCounts: false,
	showCalculations: true,
	supportsFormulas: true,
	supportsCompare: true,
	supportsOther: true,
	supportsAggregation: true,
	supportsSpread: true,
	showAxes: true,
	showLines: true,
	showResults: true,
} as const;

// Query and editor policy is shared without importing client chart components.
const policy = {
	line: standard,
	area: standard,
	bar: standard,
	stacked: standard,
	heatmap: {
		...standard,
		needsHistogram: true,
		bucketCounts: true,
		showCalculations: false,
		supportsFormulas: false,
		supportsCompare: false,
		supportsOther: false,
		supportsAggregation: false,
		supportsSpread: false,
		showLines: false,
		showResults: false,
	},
	grid: { ...standard, needsGroupBy: true, showLines: false },
	stat: {
		...standard,
		reducesSeries: true,
		supportsSpread: false,
		showAxes: false,
		showLines: false,
	},
	table: {
		...standard,
		queryShape: "table",
		supportsSpread: false,
		showAxes: false,
		showLines: false,
	},
} as const;

export type DisplayType = keyof typeof policy;
export const DISPLAY_TYPES = Object.keys(policy) as DisplayType[];
export const chartPolicy = (type: DisplayType) => policy[type];
