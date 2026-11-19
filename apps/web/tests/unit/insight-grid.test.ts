import { expect, test } from "bun:test";
import {
	bucketGrid,
	coverageBands,
	coverageState,
	NORMAL_SEND_DELAY_MS,
	onGrid,
} from "../../src/analytics/insight/grid";
import { latestHeartbeatBucket } from "../../src/analytics/runner.server";

const step = 60_000;

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
	const caughtUp = new Date(to.getTime() + NORMAL_SEND_DELAY_MS);
	expect(coverageState(coverage, grid[0], step, caughtUp, "node-b")).toBe(
		"missing",
	);
	expect(coverageState(coverage, grid[0], step, caughtUp)).toBe("reported");
	expect(coverageState(coverage, grid[0], step, caughtUp, "unknown")).toBe(
		"unknown",
	);
	expect(coverageState(null, grid[0], step, caughtUp)).toBe("unknown");
	expect(coverageBands(grid, coverage, step, caughtUp)).toEqual([
		{ from: grid[2], to: grid[4] + step, kind: "missing" },
	]);
});

test("lag at the right edge never creates a missing band, even for a single node", () => {
	const grid = [0, step, 2 * step];
	const caughtUp = new Date(step + NORMAL_SEND_DELAY_MS);
	const coverage = { a: [], b: [0, step] };
	expect(coverageState(coverage, step, step, caughtUp, "a")).toBe("arriving");
	expect(coverageBands(grid, coverage, step, caughtUp)).toEqual([
		{ from: step, to: 3 * step, kind: "arriving" },
	]);
});

test("without Kafka, use the project's latest stored heartbeat bucket", () => {
	const fallback = latestHeartbeatBucket(new Date(5 * step + 5), 60);
	expect(fallback).toEqual(new Date(5 * step));
	expect(
		coverageBands(
			[step, 2 * step, 3 * step, 4 * step, 5 * step],
			{ a: [5 * step] },
			step,
			fallback,
		),
	).toEqual([
		{ from: step, to: 4 * step, kind: "missing" },
		{ from: 4 * step, to: 6 * step, kind: "arriving" },
	]);
	expect(coverageBands([step], {}, step, null)).toEqual([]);
});
