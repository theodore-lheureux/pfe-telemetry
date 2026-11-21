import { expect, test } from "bun:test";
import { paraglideMiddleware } from "@recount/i18n/server";
import { renderToStaticMarkup } from "react-dom/server";
import {
	formatSample,
	ResourceCharts,
} from "../../src/executions/resource-charts";
import {
	parseExecutionKey,
	parseExecutionReference,
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
														timeMs: "18446744073709",
														flags: 0,
														integer: "9007199254740993",
														double: null,
													},
													{
														bucketMs: 1,
														timeMs: "1000001",
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
		expect(output).toContain("18446744073709");
		expect(output.replaceAll(/[\s\u202f\u00a0,]/g, "")).toContain(
			"9007199254740993",
		);
		expect(output).not.toContain("<circle");
		expect(output).toContain(
			locale === "en" ? "No recorded value" : "Aucune valeur enregistrée",
		);
	}
});
