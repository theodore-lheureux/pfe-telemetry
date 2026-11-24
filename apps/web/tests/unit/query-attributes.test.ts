import { expect, test } from "bun:test";
import { attributeSources } from "../../src/analytics/catalog";

test("pickers offer the attributes of the chosen metrics, or the project's before any", () => {
	expect(attributeSources([])).toEqual([undefined]);
	expect(
		attributeSources([
			"recount.node.process.cpu.utilization.distribution",
			"process.cpu.time",
			"process.cpu.time",
		]),
	).toEqual([
		"recount.node.process.cpu.utilization.distribution",
		"process.cpu.time",
	]);
});
