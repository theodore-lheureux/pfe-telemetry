import { expect, test } from "bun:test";
import { parseUpdateMetric } from "../../src/definitions/validation";

const reference = {
	organizationId: "inEIPjUrHOdOSu2JPaoUzEEMOsrFRXK1",
	projectId: "6aece5be-5fe5-4898-a52d-aadbad05bcf8",
};

test("a metric update keeps a trimmed description, distinct tags and a known status", () => {
	expect(
		parseUpdateMetric({
			...reference,
			metric: "recount.node.cpu.time",
			description: "  Busy cores  ",
			tags: ["cpu", "CPU", "fleet"],
			status: "hidden",
			ownerId: null,
			defaultBreakdown: 'attributes["cpu.mode"]',
		}),
	).toEqual({
		...reference,
		metric: "recount.node.cpu.time",
		description: "Busy cores",
		tags: ["cpu", "fleet"],
		status: "hidden",
		ownerId: null,
		defaultBreakdown: 'attributes["cpu.mode"]',
	});
});

test("a metric update rejects unknown statuses, oversized descriptions and malformed breakdowns", () => {
	const update = {
		...reference,
		metric: "recount.node.cpu.time",
		description: "",
		tags: [],
		status: null,
		ownerId: null,
		defaultBreakdown: null,
	};
	expect(() => parseUpdateMetric({ ...update, status: "deleted" })).toThrow();
	expect(() =>
		parseUpdateMetric({ ...update, defaultBreakdown: "cpu.mode" }),
	).toThrow();
	expect(
		parseUpdateMetric({ ...update, defaultBreakdown: "node" }),
	).toMatchObject({ defaultBreakdown: "node" });
	expect(() =>
		parseUpdateMetric({ ...update, description: "x".repeat(1001) }),
	).toThrow();
});
