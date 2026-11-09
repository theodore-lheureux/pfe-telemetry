import { expect, test } from "bun:test";
import { oneCreateRetry } from "../../src/lib/mutation-create-retry";

test("a create retry consumes the exact normalized input and request ID once", () => {
	const input = {
		requestId: crypto.randomUUID(),
		name: "Normalized",
		scope: "project",
	};
	const take = oneCreateRetry(input, () => true);
	expect(take()?.input).toBe(input);
	expect(take()).toBeNull();
	expect(take()).toBeNull();
});

test("retired create input cannot be reused after account, project or document retirement", () => {
	for (const reason of ["identity", "navigation", "document"]) {
		const controller = new AbortController();
		const take = oneCreateRetry(
			{ requestId: crypto.randomUUID() },
			() => !controller.signal.aborted,
		);
		controller.abort(reason);
		expect(take()).toBeNull();
	}
});
