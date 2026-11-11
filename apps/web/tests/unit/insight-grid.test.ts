import { expect, test } from "bun:test";
import {
	bucketGrid,
	offlineBands,
	onGrid,
	online,
} from "../../src/analytics/insight/grid";

test("charts span the whole range and explain gaps by node coverage", () => {
	const from = new Date("2026-11-11T10:00:30Z"),
		to = new Date("2026-11-11T10:05:00Z");
	const grid = bucketGrid(from, to, 60);
	// Buckets align to the interval, so the range's first bucket starts before `from`.
	expect(
		grid.map((bucket) => new Date(bucket).toISOString().slice(11, 16)),
	).toEqual(["10:00", "10:01", "10:02", "10:03", "10:04"]);
	expect(
		onGrid([{ bucketMs: grid[1] as number, value: 5 }], grid).map(
			(point) => point.value,
		),
	).toEqual([null, 5, null, null, null]);
	const coverage = {
		"node-a": [grid[0], grid[1]] as number[],
		"node-b": [grid[1]] as number[],
	};
	expect(online(coverage, grid[0] as number, "node-b")).toBe(false);
	expect(online(coverage, grid[0] as number)).toBe(true);
	expect(online(coverage, grid[0] as number, "unknown")).toBeNull();
	expect(online(null, grid[0] as number)).toBeNull();
	expect(offlineBands(grid, coverage, 60_000)).toEqual([
		{ from: grid[2], to: (grid[4] as number) + 60_000 },
	]);
});
