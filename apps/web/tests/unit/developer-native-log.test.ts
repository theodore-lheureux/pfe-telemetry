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
