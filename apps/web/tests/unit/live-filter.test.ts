import { expect, test } from "bun:test";
import type { LiveEvent } from "../../src/activity/contracts";
import { liveMatches, parseLiveNodes } from "../../src/activity/live-filter";

function event(nodes: string[], limited = false): LiveEvent {
	return {
		projectId: "p",
		limited,
		nodeTimes: [],
		summary: {
			id: "r",
			sourceId: "s",
			receivedAt: new Date(0),
			measuredAt: null,
			nodes: nodes.map((id) => ({ id, name: id, fingerprint: id })),
			resources: 1,
			metrics: 1,
			points: 1,
			bytes: 1,
			partition: 0,
			offset: "0",
		},
	};
}

test("a Live node filter keeps packets listing a chosen node, or that may include one", () => {
	const chosen = new Set(["a"]);
	expect(liveMatches(event(["b", "a"]), chosen)).toBe(true);
	expect(liveMatches(event(["b"]), chosen)).toBe(false);
	expect(liveMatches(event([]), chosen)).toBe(false);
	// A truncated node list cannot rule a chosen node out.
	expect(liveMatches(event(["b"], true), chosen)).toBe(true);
	expect(liveMatches(event(["b"]), new Set())).toBe(true);
});

test("Live node filters are bounded lists of identifiers", () => {
	expect(parseLiveNodes(null)).toEqual([]);
	expect(parseLiveNodes("a,b,a")).toEqual(["a", "b"]);
	expect(() => parseLiveNodes("a b")).toThrow();
	expect(() =>
		parseLiveNodes(Array.from({ length: 21 }, (_, i) => `n${i}`).join(",")),
	).toThrow();
});
