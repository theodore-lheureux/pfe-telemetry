import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_DRAFT, newSeries } from "../../src/analytics/insight/draft";
import { FormulaFields } from "../../src/analytics/insight/formula-fields";
import { TooltipProvider } from "../../src/components/ui/tooltip";

test("formula save is an icon beside remove with a short name placeholder", () => {
	const html = renderToStaticMarkup(
		<TooltipProvider>
			<FormulaFields
				userId="user"
				reference={{
					organizationId: "organization",
					projectId: "00000000-0000-4000-8000-000000000001",
				}}
				draft={{
					...DEFAULT_DRAFT,
					series: [{ ...newSeries("A"), metric: "test.metric" }],
					formulas: [{ expression: "A" }],
				}}
				disabled={false}
				canWrite
				onChange={() => {}}
			/>
		</TooltipProvider>,
	);
	const save = html.indexOf('aria-label="Save as calculated metric"');
	const remove = html.indexOf('aria-label="Remove formula 1"');
	expect(save).toBeGreaterThan(-1);
	expect(remove).toBeGreaterThan(save);
	expect(html).not.toContain(">Save as calculated metric<");
	expect(html).toContain('placeholder="Name (optional)"');
	expect(html).toContain("lucide-save");
});
