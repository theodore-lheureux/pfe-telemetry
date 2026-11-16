import { expect, test } from "bun:test";
import { applyDashboardFilters } from "../../src/analytics/dashboard-filters";
import {
	DEFAULT_DRAFT,
	decodeDraft,
	encodeDraft,
	type InsightDraft,
	sameDraft,
	toQuery,
	withDisplay,
} from "../../src/analytics/insight/draft";

const now = new Date("2026-11-11T12:00:00Z");
const draft: InsightDraft = {
	...DEFAULT_DRAFT,
	series: [
		{
			name: "A",
			metric: "recount.node.cpu.time",
			calculation: "rate",
			combine: "sum",
			filters: [
				{ field: 'attributes["cpu.mode"]', op: "neq", values: ["idle"] },
			],
		},
		{
			name: "B",
			metric: "recount.node.cpu.time",
			calculation: "rate",
			combine: "sum",
			filters: [],
		},
	],
	formulas: [{ expression: "A / B * 100", name: "CPU busy" }],
	groupBy: "node",
	range: { kind: "between", from: new Date("2026-11-11T10:00:00Z"), to: now },
	compare: { previous: true },
};

test("drafts survive the URL and become the server's query", () => {
	expect(decodeDraft(encodeDraft(draft))).toEqual(draft);
	const query = toQuery(draft, now, "UTC", "en");
	expect(query).toMatchObject({
		shape: "timeseries",
		range: { from: "2026-11-11T10:00:00.000Z", to: "2026-11-11T12:00:00.000Z" },
		// Two hours at roughly 150 buckets is a one-minute interval.
		interval: "1m",
		formulas: [{ name: "F1", expression: "A / B * 100" }],
		groupBy: ["node"],
		compare: { previous: true },
	});
	expect(query?.measures.map((measure) => measure.name)).toEqual(["A", "B"]);
	// A series without a metric yet runs nothing.
	expect(toQuery(DEFAULT_DRAFT, now, "UTC", "en")).toBeNull();
	// Unreadable URLs fall back to a fresh draft.
	expect(decodeDraft("{not json")).toBe(DEFAULT_DRAFT);
	expect(decodeDraft(JSON.stringify({ series: [] }))).toBe(DEFAULT_DRAFT);
});

test("drafts compare by content, not key order", () => {
	const reordered = decodeDraft(
		JSON.stringify(
			Object.fromEntries(
				Object.entries(JSON.parse(encodeDraft(draft))).reverse(),
			),
		),
	);
	expect(sameDraft(reordered, draft)).toBe(true);
	expect(sameDraft({ ...draft, groupBy: "host" }, draft)).toBe(false);
});

test("Number insights discard breakdowns and group aggregation at every query boundary", () => {
	const grouped: InsightDraft = {
		...draft,
		aggregate: "p95",
		display: { ...draft.display, spread: "range" },
	};
	const number = withDisplay(grouped, {
		...grouped.display,
		type: "stat",
		numberChart: "bar",
	});
	expect(number.groupBy).toBeUndefined();
	expect(number.aggregate).toBeUndefined();
	expect(number.display.spread).toBeUndefined();
	expect(decodeDraft(encodeDraft(number))).toEqual(number);
	const overridden = applyDashboardFilters(number, {
		breakdown: 'attributes["cpu.mode"]',
	});
	expect(overridden.groupBy).toBeUndefined();
	const query = toQuery(
		{ ...grouped, display: number.display },
		now,
		"UTC",
		"en",
	);
	expect(query?.groupBy).toEqual([]);
	expect(query?.aggregate).toBeUndefined();
	expect(query?.spread).toBeUndefined();
});

test("Number insights keep exactly one output, including in raw query drafts", () => {
	const display = { ...draft.display, type: "stat" as const };
	const plain = withDisplay({ ...draft, formulas: [] }, display);
	expect(plain.series).toHaveLength(1);
	expect(plain.series[0]).toEqual(draft.series[0]);
	expect(decodeDraft(encodeDraft(plain))).toEqual(plain);
	expect(
		toQuery({ ...draft, formulas: [], display }, now, "UTC", "en")?.measures,
	).toHaveLength(1);
	const formula = withDisplay(
		{
			...draft,
			formulas: [{ expression: "A / B" }, { expression: "A + B" }],
		},
		display,
	);
	expect(formula.series).toHaveLength(2);
	expect(formula.formulas).toEqual([{ expression: "A / B" }]);
	expect(toQuery(formula, now, "UTC", "en")?.formulas).toEqual([
		{ name: "F1", expression: "A / B" },
	]);
	expect(
		toQuery({ ...formula, formulas: [{ expression: "" }] }, now, "UTC", "en"),
	).toBeNull();
	expect(
		withDisplay({ ...formula, formulas: [] }, display).series,
	).toHaveLength(1);
});
