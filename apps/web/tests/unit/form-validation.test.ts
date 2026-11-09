import { expect, test } from "bun:test";
import { m } from "@recount/i18n/messages";
import { paraglideMiddleware } from "@recount/i18n/server";
import { FormApi } from "@tanstack/react-form";
import { credentialFormValues } from "../../src/credentials/setup";
import { parseTimestamp } from "../../src/executions/validation";
import {
	validationError,
	validationMessages,
} from "../../src/lib/form-validation";

test("Form owns parser errors, blocks invalid submission and explicitly applies transformations", async () => {
	const values = {
		name: " Source ",
		sourceId: " runner ",
		rootId: " node ",
		expiresAt: "",
		maximumSubmissionAge: "3600",
		allowedClockSkew: "60",
	};
	const saved: ReturnType<typeof credentialFormValues>[] = [];
	const form = new FormApi({
		defaultValues: values,
		validators: {
			onSubmit: ({ value }) =>
				validationError(() => credentialFormValues(value)),
		},
		onSubmit: ({ value }) => {
			saved.push(credentialFormValues(value));
		},
	});
	const unmount = form.mount();
	try {
		form.setFieldValue("rootId", "recount.local.reserved");
		await form.handleSubmit();
		expect(saved).toHaveLength(0);
		expect(form.state.errorMap.onSubmit).toBeTruthy();
		form.setFieldValue("rootId", values.rootId);
		await form.handleSubmit();
		expect(form.state.errorMap.onSubmit).toBeUndefined();
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			name: "Source",
			rootId: "node",
			sourceId: "runner",
			maximumSubmissionAge: 3600,
		});
		form.setFieldValue("allowedClockSkew", "18446744073");
		await form.handleSubmit();
		expect(saved).toHaveLength(1);
	} finally {
		unmount();
	}
});

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
						credentialFormValues({
							name: "Source",
							sourceId: "runner",
							rootId: "recount.local.reserved",
							expiresAt: "",
							maximumSubmissionAge: "3600",
							allowedClockSkew: "60",
						}),
					),
				}),
		);
		expect(await response.json()).toEqual({
			timestamp: m.error_invalid_range({}, { locale }),
			identifier: m.error_identifier({}, { locale }),
		});
	}
});
