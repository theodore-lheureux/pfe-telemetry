import { expect, test } from "bun:test";
import { paraglideMiddleware } from "@recount/i18n/server";
import { renderToStaticMarkup } from "react-dom/server";
import {
	formatSample,
	ResourceCharts,
} from "../../src/executions/resource-charts";
import {
	parseCreateExecution,
	parseTelemetryInput,
	parseTimestamp,
} from "../../src/executions/validation";

const reference = {
	organizationId: "org",
	projectId: "019a4790-d1da-7000-8000-000000000002",
	executionId: "019a4790-d1da-7000-8000-000000000003",
};
test("validates calendar timestamps, fixed windows and bounded resolution", () => {
	expect(parseTimestamp("2026-11-03T12:00:00+02:00")).toBe(
		"2026-11-03T10:00:00.000Z",
	);
	for (const value of [
		"1969-12-31T23:59:59Z",
		"2026-02-30T00:00:00Z",
		"2026-11-03",
		"2026-11-03T24:00:00Z",
		"2026-11-03T00:00:00.000001Z",
		"2101-01-01T00:00:00Z",
	])
		expect(() => parseTimestamp(value)).toThrow();
	expect(() => parseTelemetryInput({ ...reference, buckets: 601 })).toThrow();
	expect(() => parseTelemetryInput({ ...reference, buckets: 0.5 })).toThrow();
	expect(
		parseTelemetryInput({
			...reference,
			sourceId: "foreign",
			hostId: "other-resource",
		}),
	).toEqual({ ...reference, buckets: 300 });
	const input = {
		requestId: crypto.randomUUID(),
		...reference,
		credentialId: reference.executionId,
		name: "Test",
		startedAt: "2026-11-03T00:00:00Z",
		endedAt: "2026-11-02T00:00:00Z",
	};
	expect(() => parseCreateExecution(input)).toThrow();
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
