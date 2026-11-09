import { expect, test } from "bun:test";
import { parseCreateExecution } from "../../src/executions/validation";
import { createInputHash } from "../../src/lib/create-once.server";
import {
	parseCreateProjectInput,
	parseRequestId,
} from "../../src/organizations/validation";

const requestId = "019a4790-d1da-7000-8000-00000000000a";
const projectId = "019a4790-d1da-7000-8000-00000000000b";

test("creates require a caller-owned UUID and strip nonsemantic request fields", () => {
	for (const value of [
		undefined,
		null,
		"",
		"constructor",
		"not-a-uuid",
		{},
		`${requestId}\n`,
	])
		expect(() => parseRequestId(value)).toThrow();
	expect(parseRequestId(requestId.toUpperCase())).toBe(requestId);
	const input = { organizationId: "org", name: "  Name  ", slug: "name" };
	expect(() => parseCreateProjectInput(input)).toThrow();
	expect(
		parseCreateProjectInput({
			...input,
			requestId,
			locale: "fr",
			actorId: "foreign",
		}),
	).toEqual({ organizationId: "org", name: "Name", slug: "name", requestId });
});

test("execution input canonicalizes UUIDs, instants and empty host without changing identifier case", () => {
	const input = {
		requestId: requestId.toUpperCase(),
		organizationId: "Org",
		projectId: projectId.toUpperCase(),
		credentialId: requestId.toUpperCase(),
		name: "  Capture  ",
		hostId: "",
		startedAt: "2026-11-03T12:00:00+02:00",
		endedAt: "2026-11-03T12:05:00+02:00",
	};
	expect(parseCreateExecution(input)).toEqual({
		requestId,
		organizationId: "Org",
		projectId,
		credentialId: requestId,
		name: "Capture",
		hostId: null,
		startedAt: "2026-11-03T10:00:00.000Z",
		endedAt: "2026-11-03T10:05:00.000Z",
	});
	expect(parseCreateExecution({ ...input, hostId: "Node-A" }).hostId).toBe(
		"Node-A",
	);
	expect(() =>
		parseCreateExecution({ ...input, requestId: undefined }),
	).toThrow();
});

test("receipt fingerprints bind operation, tenant, scope and unambiguous semantic values", () => {
	const scope = {
		operation: "create-project",
		organizationId: "org",
		projectId: null,
	} as const;
	const hash = createInputHash(scope, ["Name", "name"]);
	expect(hash).toMatch(/^[0-9a-f]{64}$/);
	expect(createInputHash(scope, ["Name", "name"])).toBe(hash);
	for (const changed of [
		createInputHash({ ...scope, organizationId: "other" }, ["Name", "name"]),
		createInputHash({ ...scope, operation: "create-execution", projectId }, [
			"Name",
			"name",
		]),
		createInputHash(scope, ["name", "Name"]),
		createInputHash(scope, ["Name,name"]),
		createInputHash(scope, ["Name", "name", null]),
	])
		expect(changed).not.toBe(hash);
});
