import { expect, test } from "bun:test";
import { paraglideMiddleware } from "@recount/i18n/server";
import { renderToStaticMarkup } from "react-dom/server";
import { formatDuration } from "../../src/executions/duration";
import {
	formatSample,
	ResourceCharts,
} from "../../src/executions/resource-charts";
import {
	hasExecutionFilters,
	parseExecutionKey,
	parseExecutionList,
	parseExecutionReference,
	parseExecutionSearch,
	searchFilters,
} from "../../src/executions/validation";
import { decodeCalendarTimestamp } from "../../src/lib/calendar";

const reference = {
	organizationId: "org",
	projectId: "019a4790-d1da-7000-8000-000000000002",
	executionKey: "slurm:48213",
};
test("calendar decoding rejects malformed timestamps and execution references discard selectors", () => {
	expect(decodeCalendarTimestamp("2026-11-03T12:00:00+02:00").time).toBe(
		Date.UTC(2026, 10, 3, 10),
	);
	for (const value of [
		"2026-02-30T00:00:00Z",
		"2026-11-03",
		"2026-11-03T24:00:00Z",
		"2026-11-03T00:00:00.000001Z",
	])
		expect(decodeCalendarTimestamp(value).error).toBeTruthy();
	expect(
		parseExecutionReference({
			...reference,
			sourceId: "foreign",
			hostId: "other-resource",
		}),
	).toEqual(reference);
});

test("execution keys keep their case and reject malformed claims", () => {
	expect(parseExecutionKey("run:Node-A/one")).toBe("run:Node-A/one");
	for (const value of [
		"",
		"a".repeat(129),
		"bad\nkey",
		"run:key\n",
		"é",
		" run:key",
	])
		expect(() => parseExecutionKey(value)).toThrow();
});

test("floating-point table values retain round-trip digits", () => {
	for (const value of [
		0.0004,
		1.2345678901234567,
		Number.MIN_VALUE,
		Number.MAX_VALUE,
	])
		expect(Number(formatSample(value))).toBe(value);
});
test("renders exact large integers, missing values and translated chart labels without unsafe coordinates", async () => {
	for (const locale of ["en", "fr"] as const) {
		const response = await paraglideMiddleware(
			new Request("https://test.invalid", {
				headers: { cookie: `recount_locale=${locale}` },
			}),
			() =>
				new Response(
					renderToStaticMarkup(
						<ResourceCharts
							result={{
								from: new Date(0),
								to: new Date(1000),
								bucketMs: 1,
								series: [
									{
										id: "stream",
										metric: "recount.node.memory.total",
										unit: "By",
										hostId: "node1",
										cpuMode: null,
										segments: [
											{
												id: "epoch",
												points: [
													{
														bucketMs: 0,
														timeNs: "18446744073709551614",
														flags: 0,
														integer: "9007199254740993",
														double: null,
													},
													{
														bucketMs: 1,
														timeNs: "1000001",
														flags: 1,
														integer: null,
														double: null,
													},
												],
											},
										],
									},
								],
							}}
						/>,
					),
				),
		);
		const output = await response.text();
		expect(output).toContain("18446744073709551614");
		expect(output.replaceAll(/[\s\u202f\u00a0,]/g, "")).toContain(
			"9007199254740993",
		);
		expect(output).not.toContain("<circle");
		expect(output).toContain(
			locale === "en" ? "No recorded value" : "Aucune valeur enregistrée",
		);
	}
});

const node = "019a4790-d1da-7000-8000-0000000000aa";
const project = {
	organizationId: reference.organizationId,
	projectId: reference.projectId,
};

test("execution list input accepts only canonical filters", () => {
	const from = new Date("2026-11-03T00:00:00Z"),
		to = new Date("2026-11-04T00:00:00Z");
	expect(
		parseExecutionList({
			...project,
			q: "job",
			application: ["Alpha", "Alpha", "Beta"],
			state: "running",
			machine: [node.toUpperCase()],
			owner: [0, 4294967295],
			from,
			to,
			afterKey: "run:a",
			unknown: "ignored",
		}),
	).toEqual({
		...project,
		q: "job",
		application: ["Alpha", "Beta"],
		state: "running",
		machine: [node],
		owner: [0, 4294967295],
		from,
		to,
		afterKey: "run:a",
	});
	expect(parseExecutionList(project)).toEqual(project);
	for (const filters of [
		{ q: "" },
		{ q: " padded" },
		{ q: "x".repeat(129) },
		{ q: "line\nbreak" },
		{ application: [] },
		{ application: "Alpha" },
		{ application: Array.from({ length: 21 }, (_, i) => `a${i}`) },
		{ application: [""] },
		{ state: "failed" },
		{ machine: ["node1"] },
		{ owner: [-1] },
		{ owner: [1.5] },
		{ owner: [4294967296] },
		{ owner: ["1000"] },
		{ from: "2026-11-03T00:00:00Z" },
		{ from: new Date(Number.NaN) },
		{ from: new Date(-1) },
		{ to: new Date("2600-01-01T00:00:00Z") },
		{ from: to, to: from },
		{ from, to: from },
	])
		expect(() => parseExecutionList({ ...project, ...filters })).toThrow();
});

test("execution URL search drops invalid filters and round-trips into server filters", () => {
	const search = parseExecutionSearch({
		q: "  job  ",
		application: ["Alpha"],
		state: "failed",
		machine: [node, "not-a-node"],
		owner: [1000],
		from: "2026-11-03T02:00:00+02:00",
		to: "not a date",
		afterKey: "bad key",
	});
	expect(search).toEqual({
		q: "job",
		application: ["Alpha"],
		owner: [1000],
		from: "2026-11-03T00:00:00.000Z",
	});
	expect(searchFilters({ ...search, afterKey: "run:a" })).toEqual({
		q: "job",
		application: ["Alpha"],
		owner: [1000],
		from: new Date("2026-11-03T00:00:00Z"),
	});
	expect(
		parseExecutionSearch({
			from: "2026-11-04T00:00:00Z",
			to: "2026-11-03T00:00:00Z",
			state: "completed",
			q: "   ",
		}),
	).toEqual({ state: "completed" });
	expect(
		parseExecutionSearch({
			application: "Alpha",
			machine: node.toUpperCase(),
			owner: 0,
		}),
	).toEqual({ application: ["Alpha"], machine: [node], owner: [0] });
	expect(parseExecutionSearch({ machine: "fixture-node" })).toEqual({});
	expect(hasExecutionFilters(parseExecutionSearch({ afterKey: "run:a" }))).toBe(
		false,
	);
	expect(hasExecutionFilters({ state: "running" })).toBe(true);
});

test("observed durations show the largest unit and the next nonzero one", () => {
	expect(formatDuration(400, "en")).toBe("0 sec");
	expect(formatDuration(59_000, "en")).toBe("59 sec");
	expect(formatDuration(3_600_000 + 5 * 60_000 + 9_000, "en")).toBe(
		"1 hr 5 min",
	);
	expect(formatDuration(2 * 86_400_000 + 30 * 60_000, "en")).toBe("2 days");
	expect(formatDuration(90_000, "fr").replaceAll(/\s/g, " ")).toBe(
		"1 min 30 s",
	);
});
