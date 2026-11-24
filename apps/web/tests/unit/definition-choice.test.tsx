import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DefinitionChoice } from "../../src/analytics/definition-choice";
import { TooltipProvider } from "../../src/components/ui/tooltip";

test("shared choices show source, friendly name and description without a duplicate identifier", () => {
	for (const definition of [
		{
			kind: "metric" as const,
			name: "recount.node.cpu.time",
			label: "Node CPU",
		},
		{ kind: "attribute" as const, name: "cpu.mode", label: "CPU mode" },
	]) {
		const html = renderToStaticMarkup(
			<TooltipProvider>
				<DefinitionChoice {...definition} description="Team description" />
			</TooltipProvider>,
		);
		expect(html).toContain(`>${definition.label}</span>`);
		expect(html).toContain("Team description");
		expect(html).not.toContain(`>${definition.name}<`);
		expect(html).toContain("/brand/recount-symbol");
	}
	const custom = renderToStaticMarkup(
		<TooltipProvider>
			<DefinitionChoice kind="attribute" name="app.region" />
		</TooltipProvider>,
	);
	expect(custom).toContain(">app.region</span>");
	expect(custom).toContain('aria-label="Custom attribute"');
});
