import { expect, test } from "bun:test";
import {
	MutationFailure,
	unwrapOperation,
} from "../../src/lib/operation-result";

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
