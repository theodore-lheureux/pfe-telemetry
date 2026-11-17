const sensitiveLine =
	/\b(?:authorization|proxy-authorization|set-cookie|cookie|[\w-]*(?:password|passwd|token|secret|credential|private[_-]key|enrollment[_-]key|api[_-]key|access[_-]key)[\w-]*)["']?\s*[:=]|\brecount_enroll_[\w-]+|[?&](?:X-Amz-Signature|X-Goog-Signature)=|[a-z][\w+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i;

export function redactNativeLog(output: string[], token: string) {
	let privateKey = false;
	return output
		.join("\n")
		.split("\n")
		.map((line) => {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: match ANSI colour escape sequences.
			const text = line.replace(/\x1b\[[0-9;]*m/g, "");
			if (/-----BEGIN .*PRIVATE KEY-----/.test(text)) privateKey = true;
			const redact = privateKey || sensitiveLine.test(text);
			if (/-----END .*PRIVATE KEY-----/.test(text)) privateKey = false;
			if (redact) return "[redacted]";
			if (/\bRECOUNT_PUBLIC(?:_|\s)/.test(text)) return "";
			return token ? text.replaceAll(token, "[redacted]") : text;
		})
		.filter((line) => line !== "")
		.join("\n");
}
