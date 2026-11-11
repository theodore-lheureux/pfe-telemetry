import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serverFunctionPaths } from "../../tooling/server-function-metadata";

test("RPC metadata discovery ignores formatting and fails closed on missing or ambiguous operations", () => {
	const directory = mkdtempSync(join(tmpdir(), "recount-rpc-metadata-"));
	const path = join(directory, "ssr.mjs");
	try {
		writeFileSync(
			path,
			`
throw new Error("metadata must never execute");
const manifest = {
  'opaque/id': { 'functionName': 'read_createServerFn_handler' },
  "first": { functionName: "duplicate_createServerFn_handler" },
  "second": { functionName: "duplicate_createServerFn_handler" }
};`,
		);
		const lookup = serverFunctionPaths(pathToFileURL(path));
		writeFileSync(path, "invalid replacement build");
		expect(lookup("read")).toBe("/_serverFn/opaque%2Fid");
		expect(() => lookup("missing")).toThrow("Expected one");
		expect(() => lookup("duplicate")).toThrow("Expected one");
	} finally {
		rmSync(directory, { recursive: true });
	}
});
