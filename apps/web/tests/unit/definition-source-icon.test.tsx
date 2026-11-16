import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DefinitionSourceIcon } from "../../src/analytics/definition-source-icon";
import { TooltipProvider } from "../../src/components/ui/tooltip";

test("metric source icons distinguish Recount's catalog from custom metrics accessibly", () => {
	const builtIn = renderToStaticMarkup(
		<TooltipProvider>
			<DefinitionSourceIcon kind="metric" name="recount.node.cpu.time" />
		</TooltipProvider>,
	);
	expect(builtIn).toContain("/brand/recount-symbol-on-light.svg");
	expect(builtIn).toContain("/brand/recount-symbol-on-dark.svg");
	expect(builtIn).toContain('aria-label="Built-in Recount metric"');
	const custom = renderToStaticMarkup(
		<TooltipProvider>
			<DefinitionSourceIcon kind="metric" name="app.requests" />
		</TooltipProvider>,
	);
	expect(custom).toContain('aria-label="Custom metric"');
	expect(custom).not.toContain("/brand/recount-symbol");
});

test("attribute source icons distinguish known catalog keys from custom attributes", () => {
	const builtIn = renderToStaticMarkup(
		<TooltipProvider>
			<DefinitionSourceIcon kind="attribute" name="cpu.mode" />
		</TooltipProvider>,
	);
	expect(builtIn).toContain("/brand/recount-symbol-on-light.svg");
	expect(builtIn).toContain('aria-label="Built-in Recount attribute"');
	const custom = renderToStaticMarkup(
		<TooltipProvider>
			<DefinitionSourceIcon kind="attribute" name="app.region" />
		</TooltipProvider>,
	);
	expect(custom).toContain('aria-label="Custom attribute"');
	expect(custom).not.toContain("/brand/recount-symbol");
});
