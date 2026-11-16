import { expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeConfiguration } from "./configure";

const smtp = {
	SMTP_HOST: "smtp.example.test",
	SMTP_PORT: "465",
	SMTP_USER: "test",
	SMTP_PASSWORD: 'synthetic-$VALUE-"quote"-\\backslash',
	EMAIL_FROM: "Recount <test@example.test>",
};

test("private runtime configuration round-trips through Compose without expansion", () => {
	const directory = mkdtempSync(join(tmpdir(), "recount-bootstrap-"));
	try {
		const file = join(directory, "runtime.env");
		writeFileSync(
			file,
			runtimeConfiguration("/srv/test-data", `${"a".repeat(40)}-1-1`, smtp),
		);
		const result = Bun.spawnSync(
			[
				"docker",
				"compose",
				"--env-file",
				file,
				"--file",
				"infra/local/compose.yaml",
				"--file",
				"infra/local/compose.apps.yaml",
				"config",
				"--format",
				"json",
			],
			{ env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const services = JSON.parse(result.stdout.toString()).services;
		const web = services.web.environment;
		// Compose escapes literal dollars when serializing a reusable configuration.
		expect(web.SMTP_PASSWORD).toBe(
			smtp.SMTP_PASSWORD.replaceAll("$", () => "$$"),
		);
		expect(web.EMAIL_FROM).toBe(smtp.EMAIL_FROM);
		expect(new URL(web.DATABASE_URL).username).toBe("recount_web");
		expect(new URL(web.DATABASE_URL).password).not.toBe(
			services.postgres.environment.POSTGRES_PASSWORD,
		);
		expect(web.RECOUNT_AUTH_ALLOW_SIGN_UP).toBe("false");
		const key = createPrivateKey({
			format: "jwk",
			key: {
				kty: "OKP",
				crv: "Ed25519",
				d: web.RECOUNT_COLLECTOR_SIGNING_KEY,
				x: services["ingestion-api"].environment
					.RECOUNT_INGESTION_COLLECTOR_PUBLIC_KEYS,
			},
		});
		const publicKey = createPublicKey({
			format: "jwk",
			key: {
				kty: "OKP",
				crv: "Ed25519",
				x: services["ingestion-api"].environment
					.RECOUNT_INGESTION_COLLECTOR_PUBLIC_KEYS,
			},
		});
		const message = Buffer.from("synthetic collector token");
		expect(verify(null, message, publicKey, sign(null, message, key))).toBe(
			true,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("missing SMTP settings and multiline values are rejected", () => {
	for (const value of ["", "synthetic\ninjected=value"]) {
		expect(() =>
			runtimeConfiguration("/srv/test", `${"a".repeat(40)}-1-1`, {
				...smtp,
				SMTP_PASSWORD: value,
			}),
		).toThrow();
	}
});
