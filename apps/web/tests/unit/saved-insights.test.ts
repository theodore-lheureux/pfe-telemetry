import { expect, test } from "bun:test";
import {
	DEFAULT_DRAFT,
	decodeDraft,
	encodeDraft,
	newSeries,
} from "../../src/analytics/insight/draft";
import { parseSaveInsight } from "../../src/analytics/saved-insights-validation";
import { InputError } from "../../src/lib/input-error";

const reference = {
	organizationId: "org",
	projectId: "11111111-1111-4111-8111-111111111111",
	insightId: "22222222-2222-4222-8222-222222222222",
};
const series = {
	...newSeries("A"),
	metric: "recount.node.cpu.time",
	calculation: "rate" as const,
	combine: "sum" as const,
};

function rejects(value: unknown) {
	expect(() => parseSaveInsight(value)).toThrow(InputError);
}

test("only complete, runnable drafts with a name can be saved", () => {
	const draft = encodeDraft({ ...DEFAULT_DRAFT, series: [series] });
	const parsed = parseSaveInsight({ ...reference, name: "  CPU  ", draft });
	expect(parsed.name).toBe("CPU");
	expect(decodeDraft(parsed.draft)).toEqual(decodeDraft(draft));
	// Renaming sends no draft.
	expect(parseSaveInsight({ ...reference, name: "CPU" }).draft).toBeUndefined();
	rejects({ ...reference, name: " ", draft });
	rejects({ ...reference, name: "x".repeat(121), draft });
	rejects({ ...reference, name: "CPU", draft: "{not json" });
	// A series without a metric runs nothing.
	rejects({ ...reference, name: "CPU", draft: encodeDraft(DEFAULT_DRAFT) });
	// A formula over a missing series fails the analytics query's own validation.
	rejects({
		...reference,
		name: "CPU",
		draft: encodeDraft({
			...DEFAULT_DRAFT,
			series: [series],
			formulas: [{ expression: "A / Z" }],
		}),
	});
});
