import { describe, expect, test } from "bun:test";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import type { OperationResult } from "../../src/organizations/contracts";
import {
	organizationParams,
	projectParams,
	routeData,
} from "../../src/organizations/route-data";

function thrown(action: () => unknown) {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("Expected a thrown route outcome");
}

describe("private route outcomes", () => {
	test("preserves empty successes without treating failures as empty data", () => {
		expect(routeData({ data: [], error: null })).toEqual([]);
		const error = thrown(() =>
			routeData({
				data: null,
				error: { code: "FORBIDDEN", message: "private detail" },
			}),
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain("private detail");
	});
	test("redirects expired sessions and conceals inaccessible resources", () => {
		const failure = (
			code: NonNullable<OperationResult<never>["error"]>["code"],
		) =>
			({
				data: null,
				error: { code, message: "not exposed" },
			}) as OperationResult<never>;
		expect(
			isRedirect(thrown(() => routeData(failure("UNAUTHENTICATED")))),
		).toBe(true);
		expect(isNotFound(thrown(() => routeData(failure("NOT_FOUND"))))).toBe(
			true,
		);
	});
	test("validates both tenant and project identifiers before RPC calls", () => {
		expect(organizationParams({ organizationId: "opaque-org" })).toEqual({
			organizationId: "opaque-org",
		});
		expect(
			isNotFound(thrown(() => organizationParams({ organizationId: "" }))),
		).toBe(true);
		expect(
			isNotFound(
				thrown(() =>
					projectParams({
						organizationId: "opaque-org",
						projectId: "malformed",
					}),
				),
			),
		).toBe(true);
	});
	test("retains the attempted local destination when a child RPC loses its session", () => {
		const destination =
			"/organizations/opaque-org/projects/00000000-0000-0000-0000-000000000000/settings";
		const error = thrown(() =>
			routeData(
				{ data: null, error: { code: "UNAUTHENTICATED", message: "Sign in" } },
				destination,
			),
		);
		if (!isRedirect(error)) throw new Error("Expected a sign-in redirect");
		expect(error.options.search).toHaveProperty("redirect", destination);
	});
});
