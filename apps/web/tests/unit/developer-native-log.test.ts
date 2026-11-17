import { expect, test } from "bun:test";
import { redactNativeLog } from "../../src/developer/native-log.server";

test("the native transcript preserves diagnostic text and masks recognized credentials", () => {
	expect(
		redactNativeLog(
			[
				"TASK [Install collector] *****\nchanged: [demo-001]",
				'  "AWS_SECRET_ACCESS_KEY": "sensitive"',
				"Authorization: Bearer another-token",
				"-----BEGIN OPENSSH PRIVATE KEY-----",
				"encoded-private-key",
				"-----END OPENSSH PRIVATE KEY-----",
				"Connector error: exact-connector-token",
				"fatal: [demo-001]: package not found",
			],
			"exact-connector-token",
		),
	).toBe(
		"TASK [Install collector] *****\nchanged: [demo-001]\n[redacted]\n[redacted]\n[redacted]\n[redacted]\n[redacted]\nConnector error: [redacted]\nfatal: [demo-001]: package not found",
	);
});

test("the native transcript keeps colours but drops other terminal controls", () => {
	expect(
		redactNativeLog(
			[
				"\x1b[0;32mok: [demo-001]\x1b[0m",
				"\x1b[2Kprogress\x1b]0;title\x07\x08 done",
				"\x1b[0;33mtoken: \x1b[1mexact-connector-token\x1b[0m",
				"split exact-\x1b[0mconnector-token",
				"\x1b[0m",
			],
			"exact-connector-token",
		),
	).toBe(
		"\x1b[0;32mok: [demo-001]\x1b[0m\nprogress done\n[redacted]\n[redacted]",
	);
});
