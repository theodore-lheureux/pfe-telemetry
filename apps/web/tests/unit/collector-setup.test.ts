import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CredentialFormValues,
	collectorTokenCommand,
	credentialFormValues,
	credentialStatus,
} from "../../src/credentials/setup";

async function tokenFileExample(
	home: string,
	prefix = "",
	input = "test-only-token\n",
) {
	const child = Bun.spawn(
		[
			"bash",
			"-c",
			`${prefix}\n${collectorTokenCommand}\ntest -z "\${RECOUNT_TOKEN+x}"`,
		],
		{
			env: { ...process.env, HOME: home },
			stdin: new Blob([input]),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(await child.exited).toBe(0);
}

test("token-file instructions establish private permissions and unset temporary input", async () => {
	const home = await mkdtemp(join(tmpdir(), "recount-token-example-"));
	try {
		await tokenFileExample(home);
		const directory = join(home, ".config/recount");
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await stat(join(directory, "collector.token"))).mode & 0o777).toBe(
			0o600,
		);
		expect(await readFile(join(directory, "collector.token"), "utf8")).toBe(
			"test-only-token\n",
		);
	} finally {
		await rm(home, { recursive: true });
	}
});

test("token-file instructions do not write after failed directory or file preparation", async () => {
	const home = await mkdtemp(join(tmpdir(), "recount-token-example-"));
	try {
		const directory = join(home, ".config/recount");
		await mkdir(directory, { recursive: true });
		const file = join(directory, "collector.token");
		await writeFile(file, "existing-value", { mode: 0o644 });
		for (const prefix of [
			"install() { return 1; }",
			'install() { if [ "$1" = "-d" ]; then command install "$@"; else return 1; fi; }',
		]) {
			await tokenFileExample(home, prefix);
			expect(await readFile(file, "utf8")).toBe("existing-value");
		}
	} finally {
		await rm(home, { recursive: true });
	}
});

test("cancelling token input preserves the previous token file", async () => {
	const home = await mkdtemp(join(tmpdir(), "recount-token-example-"));
	try {
		const directory = join(home, ".config/recount");
		await mkdir(directory, { recursive: true });
		const file = join(directory, "collector.token");
		await writeFile(file, "existing-value", { mode: 0o600 });
		await tokenFileExample(home, "", "");
		expect(await readFile(file, "utf8")).toBe("existing-value");
	} finally {
		await rm(home, { recursive: true });
	}
});

function form(
	values: Partial<CredentialFormValues> = {},
): CredentialFormValues {
	return {
		name: "Staging",
		sourceId: "runner",
		rootId: "host-a",
		expiresAt: "",
		maximumSubmissionAge: "3600",
		allowedClockSkew: "60",
		...values,
	};
}

describe("collector enrollment form", () => {
	test("normalizes the root and sends explicit local-process policy", () => {
		expect(credentialFormValues(form({ rootId: " host-a " }))).toEqual({
			name: "Staging",
			sourceId: "runner",
			rootId: "host-a",
			rootKind: 1,
			adapter: "linux",
			allowedLocalKinds: [4],
			additionalRoots: [],
			resources: [],
			maximumSubmissionAge: 3600,
			allowedClockSkew: 60,
			expiresAt: null,
		});
	});
	test("requires an explicit enrolled root", () => {
		expect(() => credentialFormValues(form({ rootId: "" }))).toThrow(
			"resource identifiers",
		);
	});
	test("rejects multi-root text and invalid UTF-8 identifier lengths", () => {
		expect(() => credentialFormValues(form({ rootId: "node\nnode" }))).toThrow(
			"control",
		);
		expect(() =>
			credentialFormValues(form({ sourceId: "é".repeat(65) })),
		).toThrow("UTF-8");
		expect(() => credentialFormValues(form({ rootId: "node\tbad" }))).toThrow(
			"control",
		);
		expect(
			credentialFormValues(form({ sourceId: "é".repeat(64) })).sourceId,
		).toBe("é".repeat(64));
	});
	test("converts local expiry to an instant and rejects past/invalid expiry", () => {
		const expiry = "2099-06-20T12:30";
		expect(credentialFormValues(form({ expiresAt: expiry })).expiresAt).toBe(
			new Date(expiry).toISOString(),
		);
		expect(() =>
			credentialFormValues(form({ expiresAt: "2020-01-01T00:00" })),
		).toThrow("future");
		expect(() => credentialFormValues(form({ expiresAt: "invalid" }))).toThrow(
			"future",
		);
	});
	test("does not submit whitespace-only names", () => {
		expect(() => credentialFormValues(form({ name: " " }))).toThrow("Name");
	});
});

test("credential status prioritizes permanent revocation and expires at the boundary", () => {
	const expiresAt = new Date("2030-01-01T00:00:00Z");
	const now = expiresAt.getTime();
	expect(credentialStatus({ revokedAt: null, expiresAt: null }, now)).toBe(
		"Active",
	);
	expect(credentialStatus({ revokedAt: null, expiresAt }, now - 1)).toBe(
		"Active",
	);
	expect(credentialStatus({ revokedAt: null, expiresAt }, now)).toBe("Expired");
	expect(credentialStatus({ revokedAt: expiresAt, expiresAt }, now)).toBe(
		"Revoked",
	);
});
