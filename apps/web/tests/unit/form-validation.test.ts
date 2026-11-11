import { expect, test } from "bun:test";
import { m } from "@recount/i18n/messages";
import { paraglideMiddleware } from "@recount/i18n/server";
import { parseMachineId } from "../../src/collectors/validation";
import { parseTimestamp } from "../../src/executions/validation";
import {
	validationError,
	validationMessages,
} from "../../src/lib/form-validation";

test("structured schema and field errors display messages rather than object coercions", () => {
	expect(
		validationMessages([
			{ message: "A", path: ["name"] },
			{ form: "B", fields: { name: [{ message: "C" }] } },
			null,
		]),
	).toEqual(["A", "B", "C"]);
});

test("parser validators retain request-local English and French messages", async () => {
	for (const locale of ["en", "fr"] as const) {
		const response = await paraglideMiddleware(
			new Request("http://localhost", {
				headers: { Cookie: `recount_locale=${locale}` },
			}),
			() =>
				Response.json({
					timestamp: validationError(() =>
						parseTimestamp("2026-11-03T10:00:00.0001Z"),
					),
					identifier: validationError(() =>
						parseMachineId("recount.local.reserved"),
					),
				}),
		);
		expect(await response.json()).toEqual({
			timestamp: m.error_invalid_range({}, { locale }),
			identifier: m.error_identifier({}, { locale }),
		});
	}
});
