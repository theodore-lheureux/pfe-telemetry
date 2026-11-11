import { expect, test } from "bun:test";
import {
	DEFAULT_DRAFT,
	decodeDraft,
	encodeDraft,
	type InsightDraft,
	toQuery,
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
