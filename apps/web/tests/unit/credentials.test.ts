import { expect, test } from "bun:test";
import { MAX_U64_NANOSECONDS_DURATION_SECONDS } from "../../src/credentials/contracts";
import {
	parseCollectorCredentialReference,
	parseCreateCollectorCredentialInput,
} from "../../src/credentials/validation";

const input = {
	organizationId: "org",
	projectId: "00000000-0000-0000-0000-000000000001",
	name: "Collector",
	sourceId: "source",
	rootId: "node",
};

test("validates Rust-compatible source/resource identities and bounded enrollment policies", () => {
	expect(
		parseCreateCollectorCredentialInput({ ...input, sourceId: "é".repeat(64) }),
	).toMatchObject({
		rootId: "node",
		rootKind: 1,
		adapter: "standard",
		allowedLocalKinds: [],
		maximumSubmissionAge: 3600,
		allowedClockSkew: 60,
		expiresAt: null,
	});
	for (const patch of [
		{ sourceId: "é".repeat(65) },
		{ sourceId: "bad\u0085source" },
		{ sourceId: "bad\nsource" },
		{ sourceId: "\ud800" },
		{ rootId: "" },
		{ rootId: "recount.local.forged" },
		{ rootKind: 9 },
		{ adapter: "linux", allowedLocalKinds: [5] },
		{ adapter: "standard", allowedLocalKinds: [4] },
		{ adapter: "linux", allowedLocalKinds: [4, 4] },
		{ resources: [{ resourceId: "node", resourceKind: 1 }] },
		{ maximumSubmissionAge: 18446744074 },
		{ maximumSubmissionAge: 18446744073, allowedClockSkew: 1 },
		{ maximumSubmissionAge: Number.MAX_SAFE_INTEGER },
		{ allowedClockSkew: -1 },
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
			maximumSubmissionAge: 7 * 86400,
			allowedClockSkew: 0,
			adapter: "linux",
			allowedLocalKinds: [4],
			resources: [{ resourceId: "vm", resourceKind: 5 }],
		}),
	).toMatchObject({
		maximumSubmissionAge: 604800,
		allowedClockSkew: 0,
		allowedLocalKinds: [4],
		resources: [{ resourceId: "vm", resourceKind: 5 }],
	});
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

test("finite duration bounds include zero skew but require combined age-plus-skew headroom", () => {
	const max = MAX_U64_NANOSECONDS_DURATION_SECONDS;
	expect(max).toBe(18_446_744_073);
	for (const [maximumSubmissionAge, allowedClockSkew] of [
		[max, 0],
		[max - 1, 1],
		[1, max - 1],
	]) {
		expect(
			parseCreateCollectorCredentialInput({
				...input,
				maximumSubmissionAge,
				allowedClockSkew,
			}),
		).toMatchObject({ maximumSubmissionAge, allowedClockSkew });
	}
	for (const patch of [
		{ maximumSubmissionAge: 0 },
		{ maximumSubmissionAge: max + 1, allowedClockSkew: 0 },
		{ maximumSubmissionAge: max, allowedClockSkew: 1 },
		{ maximumSubmissionAge: 1, allowedClockSkew: max },
		{ maximumSubmissionAge: Infinity },
		{ allowedClockSkew: Infinity },
		{ maximumSubmissionAge: NaN },
		{ allowedClockSkew: NaN },
	]) {
		expect(() =>
			parseCreateCollectorCredentialInput({ ...input, ...patch }),
		).toThrow();
	}
});
