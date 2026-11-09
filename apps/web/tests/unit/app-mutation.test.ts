import { expect, test } from "bun:test";
import {
	MutationFailure,
	unwrapOperation,
} from "../../src/components/use-app-mutation";

test("application mutations reject typed domain failures instead of reporting Query success", () => {
	const failure = {
		code: "CONFLICT",
		reason: "REQUEST_ID_REUSED",
		message: "Different submission",
	} as const;
	try {
		unwrapOperation({ data: null, error: failure });
		throw new Error("Expected a rejected domain outcome");
	} catch (error) {
		expect(error).toBeInstanceOf(MutationFailure);
		expect((error as MutationFailure).failure).toBe(failure);
	}
});

test("application mutation unwrapping preserves native Date values and safe domain results", () => {
	const data = {
		executionId: "execution",
		startedAt: new Date("2026-11-03T10:00:00Z"),
	};
	const result = unwrapOperation({ data, error: null });
	expect(result).toBe(data);
	expect(result.startedAt).toBeInstanceOf(Date);
	expect(result.startedAt).toBe(data.startedAt);
});
