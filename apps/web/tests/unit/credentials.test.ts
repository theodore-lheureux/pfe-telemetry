import { expect, test } from "bun:test";
import {
	parseCollectorCredentialReference,
	parseCreateCollectorCredentialInput,
} from "../../src/credentials/validation";

const input = {
	organizationId: "org",
	projectId: "00000000-0000-0000-0000-000000000001",
	name: "Collector",
	sourceId: "source",
	hosts: ["node"],
};

test("validates Rust-compatible source/host identities and bounded enrollment policies", () => {
	expect(
		parseCreateCollectorCredentialInput({ ...input, sourceId: "é".repeat(64) }),
	).toMatchObject({
		requireHostId: true,
		maximumSubmissionAge: 3600,
		allowedClockSkew: 60,
		expiresAt: null,
	});
	for (const patch of [
		{ sourceId: "é".repeat(65) },
		{ sourceId: "bad\u0085source" },
		{ sourceId: "bad\nsource" },
		{ sourceId: "\ud800" },
		{ hosts: [] },
		{ hosts: ["node", "node"] },
		{ hosts: [null] },
		{ hosts: Array(257).fill("node") },
		{ requireHostId: "false" },
		{ requireHostId: null },
		{ maximumSubmissionAge: 86401 },
		{ allowedClockSkew: 0 },
		{ allowedClockSkew: 1.5 },
		{ expiresAt: "2030-01-01" },
		{ expiresAt: "invalid" },
		{ expiresAt: "2030-02-30T00:00:00Z" },
		{ expiresAt: "2027-02-29T00:00:00Z" },
	])
		expect(() =>
			parseCreateCollectorCredentialInput({ ...input, ...patch }),
		).toThrow();
	expect(
		parseCreateCollectorCredentialInput({
			...input,
			hosts: [],
			requireHostId: false,
		}).hosts,
	).toEqual([]);
	expect(() =>
		parseCollectorCredentialReference({ ...input, credentialId: "not-a-uuid" }),
	).toThrow();
});

test("preserves valid leap days and timezone-bearing expiry instants", () => {
	expect(
		parseCreateCollectorCredentialInput({
			...input,
			expiresAt: "2028-02-29T23:30:00+02:00",
		}).expiresAt,
	).toBe("2028-02-29T21:30:00.000Z");
	expect(() =>
		parseCreateCollectorCredentialInput({
			...input,
			expiresAt: "2100-02-29T00:00:00Z",
		}),
	).toThrow();
	expect(
		parseCreateCollectorCredentialInput({
			...input,
			expiresAt: "2000-02-29T00:00:00Z",
		}).expiresAt,
	).toBe("2000-02-29T00:00:00.000Z");
});
